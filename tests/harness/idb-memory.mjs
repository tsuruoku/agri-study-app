// Minimal in-memory IndexedDB subset for Node tests only. Implements just the
// API surface storage.js uses: open/upgradeneeded, named object stores with
// keyPath, get/put/add/getAll/clear/delete, index.get, and transactions that
// roll back (snapshot restore) when any request fails. Never used by
// production code.

function clone(v) {
  return v === undefined ? undefined : structuredClone(v);
}

function nextTick(fn) {
  queueMicrotask(fn);
}

class MStore {
  constructor(tx, meta) {
    this._tx = tx;
    this._meta = meta;
  }
  _op(fn) {
    const req = { result: undefined, error: null, onsuccess: null, onerror: null };
    this._tx._queue(req, fn);
    return req;
  }
  get(key) {
    return this._op(req => {
      req.result = clone(this._meta.data.get(key));
    });
  }
  getAll() {
    return this._op(req => {
      req.result = [...this._meta.data.values()].map(clone);
    });
  }
  put(value, key) {
    return this._op(req => {
      const k = this._meta.keyPath ? value[this._meta.keyPath] : key;
      if (k === undefined || k === null)
        throw new Error("DataError: no key for value");
      this._meta.data.set(k, clone(value));
      req.result = k;
    });
  }
  add(value, key) {
    return this._op(req => {
      const k = this._meta.keyPath ? value[this._meta.keyPath] : key;
      if (k === undefined || k === null) throw new Error("DataError: no key for value");
      if (this._meta.data.has(k)) throw new Error("ConstraintError: duplicate key");
      this._meta.data.set(k, clone(value));
      req.result = k;
    });
  }
  delete(key) {
    return this._op(req => {
      this._meta.data.delete(key);
      req.result = undefined;
    });
  }
  clear() {
    return this._op(req => {
      this._meta.data.clear();
      req.result = undefined;
    });
  }
  index(name) {
    const keyPath = this._meta.indexes.get(name);
    if (keyPath === undefined) throw new Error(`NotFoundError: index ${name}`);
    const meta = this._meta;
    const tx = this._tx;
    return {
      get(key) {
        const req = { result: undefined, error: null, onsuccess: null, onerror: null };
        tx._queue(req, r => {
          r.result = undefined;
          for (const v of meta.data.values()) {
            if (v[keyPath] === key) {
              r.result = clone(v);
              break;
            }
          }
        });
        return req;
      },
    };
  }
}

class MTransaction {
  constructor(db, names) {
    this._db = db;
    this._names = new Set(Array.isArray(names) ? names : [names]);
    this._ops = [];
    this._pending = 0;
    this._aborted = false;
    this._finished = false;
    this.oncomplete = null;
    this.onerror = null;
    this.onabort = null;
    this.error = null;
    this._snapshot = new Map();
    for (const n of this._names) {
      const meta = db._stores.get(n);
      if (!meta) throw new Error(`NotFoundError: store ${n}`);
      this._snapshot.set(n, new Map([...meta.data].map(([k, v]) => [k, clone(v)])));
    }
    nextTick(() => this._pump());
  }
  objectStore(name) {
    if (!this._names.has(name)) throw new Error(`NotFoundError: store ${name}`);
    return new MStore(this, this._db._stores.get(name));
  }
  _queue(req, fn) {
    if (this._finished) throw new Error("InvalidStateError: transaction finished");
    this._ops.push({ req, fn });
    this._pending++;
  }
  _pump() {
    if (this._aborted) return;
    const op = this._ops.shift();
    if (!op) {
      if (this._pending === 0 && !this._finished) {
        this._finished = true;
        if (this.oncomplete) this.oncomplete();
      }
      return;
    }
    try {
      op.fn(op.req);
      this._pending--;
      if (op.req.onsuccess) op.req.onsuccess({ target: op.req });
    } catch (e) {
      this._pending--;
      op.req.error = e;
      if (op.req.onerror) op.req.onerror({ target: op.req });
      this._abort(e);
      return;
    }
    nextTick(() => this._pump());
  }
  _abort(err) {
    if (this._aborted || this._finished) return;
    this._aborted = true;
    this._finished = true;
    this.error = err;
    for (const [name, data] of this._snapshot) {
      this._db._stores.get(name).data = data;
    }
    if (this.onabort) this.onabort();
    else if (this.onerror) this.onerror({ target: this });
  }
  abort() {
    this._abort(new Error("AbortError"));
  }
}

class MDatabase {
  constructor(name, version) {
    this.name = name;
    this.version = version;
    this._stores = new Map();
    this.onclose = null;
  }
  get objectStoreNames() {
    const names = [...this._stores.keys()];
    return { contains: n => names.includes(n), length: names.length, [Symbol.iterator]: () => names[Symbol.iterator]() };
  }
  createObjectStore(name, opts = {}) {
    if (this._stores.has(name)) throw new Error(`ConstraintError: store ${name} exists`);
    const meta = { keyPath: opts.keyPath || null, data: new Map(), indexes: new Map() };
    this._stores.set(name, meta);
    return {
      createIndex: (indexName, keyPath) => meta.indexes.set(indexName, keyPath),
    };
  }
  deleteObjectStore(name) {
    this._stores.delete(name);
  }
  transaction(names, _mode = "readonly") {
    return new MTransaction(this, names);
  }
  close() {}
}

export function createIDBFactory() {
  const dbs = new Map();
  return {
    open(name, version = 1) {
      const req = { result: null, error: null, onsuccess: null, onerror: null, onupgradeneeded: null };
      nextTick(() => {
        try {
          let db = dbs.get(name);
          if (!db) {
            db = new MDatabase(name, version);
            dbs.set(name, db);
            req.result = db;
            if (req.onupgradeneeded) req.onupgradeneeded({ target: req, oldVersion: 0, newVersion: version });
          } else if (db.version < version) {
            db.version = version;
            req.result = db;
            if (req.onupgradeneeded) req.onupgradeneeded({ target: req });
          } else {
            req.result = db;
          }
          if (req.onsuccess) req.onsuccess({ target: req });
        } catch (e) {
          req.error = e;
          if (req.onerror) req.onerror({ target: req });
        }
      });
      return req;
    },
    deleteDatabase(name) {
      const req = { result: undefined, error: null, onsuccess: null, onerror: null };
      nextTick(() => {
        dbs.delete(name);
        if (req.onsuccess) req.onsuccess({ target: req });
      });
      return req;
    },
    _dbs: dbs,
  };
}
