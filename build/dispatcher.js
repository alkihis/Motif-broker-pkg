"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : new P(function (resolve) { resolve(result.value); }).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
if (typeof window === "undefined" || !window.fetch) {
    var fetch = require('node-fetch');
}
/**
 * Massive ID getter for multiple CouchDB documents
 *
 * @export
 * @class Dispatcher
 */
class Dispatcher {
    /**
     * Creates an instance of Dispatcher.
     * @param {string} database_link URL to the database
     * @param {EndpointAccepters} accept_functions Document name => function that return true if key is accepted in the document
     * @param {number} [packet_size=64] Max number of queries sended to the database in one time
     * @memberof Dispatcher
     */
    constructor(database_link, accept_functions = {}, packet_size = 64) {
        this.pool = {};
        this.private_pool = {};
        this.url = database_link;
        this.packet_size_per_queue = packet_size;
        for (const [endpoint, func] of Object.entries(accept_functions)) {
            this.set(endpoint, func);
        }
    }
    /**
     * Load ids into queues (Massive ID getter)
     *
     * @param {string[]} ids
     * @returns {number} Numeric ID to flush with
     * @memberof Dispatcher
     */
    load(ids, custom) {
        let ok;
        const uniq_id = Math.random();
        for (const k of ids) {
            ok = false;
            if (custom) {
                if (!(custom in this.pool)) {
                    this.set(custom, () => true, undefined, true);
                }
                this.pool[custom].push(k, uniq_id);
                continue;
            }
            for (const q of Object.values(this.pool).filter(p => !p.hidden)) {
                ok = q.push(k, uniq_id);
                if (ok) {
                    break;
                }
            }
            if (!ok) {
                console.error("Could not assign " + k + " in any request");
            }
        }
        return uniq_id;
    }
    /**
     * Flush all queues.
     *
     * @returns Promise<any>
     * @memberof Dispatcher
     */
    flush(id) {
        return __awaiter(this, void 0, void 0, function* () {
            const data = [];
            for (const q of Object.values(this.pool)) {
                data.push(yield q.flush(id));
            }
            return this.flattenList(data);
        });
    }
    /**
     * Flush all queues using a parallel method.
     *
     * @returns
     * @memberof Dispatcher
     */
    pFlush(id) {
        return __awaiter(this, void 0, void 0, function* () {
            return this.flattenList(yield Promise.all(Object.values(this.pool).map(q => q.flush(id))));
        });
    }
    flattenList(data) {
        const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
        const f = (a, b) => __awaiter(this, void 0, void 0, function* () {
            yield sleep(5);
            for (const e of b) {
                if ('error' in e)
                    continue;
                if (!('id' in e))
                    throw (`No "id" in ${e}`);
                if (e['id'] in a)
                    throw (`Common "id\" in accumulator:\n${e}\nand curr datum\n${e}`);
                a[e['id']] = {};
                for (let k in e) {
                    if (k === 'id')
                        continue;
                    a[e['id']][k] = e[k];
                }
            }
            return a;
        });
        return data.reduce((previous, next) => __awaiter(this, void 0, void 0, function* () {
            return f(yield previous, next);
        }), Promise.resolve({}));
    }
    /**
     * Remove an endpoint
     * @param endpoint
     */
    remove(endpoint) {
        if (endpoint in this.pool) {
            delete this.pool[endpoint];
        }
        else {
            console.warn('Corresponding endpoint queue not found');
        }
    }
    /**
     * Set an endpoint
     * @param endpoint Name
     * @param accept_function Accepter function
     * @param packet_size Number of packets max
     * @param hidden Hidden endpoint or not
     */
    set(endpoint, accept_function, packet_size = this.packet_size_per_queue, hidden = false) {
        if (endpoint in this.pool) {
            // Mise à jour de l'ancienne Queue
            if (accept_function)
                this.pool[endpoint].accept_fn = accept_function;
            if (packet_size > 0)
                this.pool[endpoint].packet_size = packet_size;
            this.pool[endpoint].hidden = hidden;
        }
        else {
            // Nouvelle Queue
            this.pool[endpoint] = new Queue(this.url + "/" + endpoint, accept_function, packet_size);
            this.pool[endpoint].hidden = hidden;
        }
    }
}
exports.default = Dispatcher;
class Queue {
    constructor(endpoint, accept_function, max_packet = 64) {
        this.pool = [];
        this.pool_by_id = {};
        this.hidden = false;
        this.endpoint = endpoint;
        this.max_packet = max_packet;
        this.accept_fn = accept_function;
    }
    push(key, unique_id) {
        const val = typeof this.accept_fn === 'function' ? this.accept_fn(key) : this.accept_fn.test(key);
        if (val) {
            if (typeof val === 'string') {
                // On ajoute la valeur modifiée plutôt que key
                key = val;
            }
            if (unique_id in this.pool_by_id) {
                this.pool_by_id[unique_id].push(key);
            }
            else {
                this.pool_by_id[unique_id] = [key];
            }
            return true;
        }
        return false;
    }
    get length() {
        return this.pool.length;
    }
    get url() {
        return this.endpoint;
    }
    get packet_size() {
        return this.max_packet;
    }
    set packet_size(v) {
        this.max_packet = v;
    }
    wrapBulk(ids) {
        return {
            docs: ids.map(id => { return { id }; })
        };
    }
    flush(id) {
        return __awaiter(this, void 0, void 0, function* () {
            if (!(id in this.pool_by_id)) {
                return [];
            }
            const packets_ready = [];
            for (let index = 0; index < this.pool_by_id[id].length; index += this.packet_size) {
                packets_ready.push(this.pool_by_id[id].slice(index, index + this.packet_size));
            }
            const packets_promises = packets_ready.map(packet => {
                return fetch(this.endpoint + '/_bulk_get', {
                    method: 'POST',
                    body: JSON.stringify(this.wrapBulk(packet)),
                    headers: { "Content-Type": "application/json" }
                })
                    .then(r => r.ok ? r.json() : r.json().then(e => Promise.reject(e)))
                    .then(body => {
                    if ("results" in body) {
                        const results = body.results;
                        return Promise.resolve(results.map(p => {
                            const data = p.docs[0];
                            if ("error" in data) {
                                return data.error;
                            }
                            // On filtre les clés qui commençent par _
                            return Object.keys(data.ok).reduce((o, k) => {
                                if (!k.startsWith('_')) {
                                    o[k] = data.ok[k];
                                }
                                return o;
                            }, { id: p.id });
                        }));
                    }
                    // No result
                    return Promise.reject("No result in data");
                });
            });
            return Promise.all(packets_promises)
                .then(data => [].concat(...data));
        });
    }
}
class Routes {
    constructor(accepters, database_url = "http://localhost:5984", json_limit = 50) {
        this.app = express_1.default();
        this.app.use(express_1.default.json({ limit: json_limit * 1024 * 1024 }));
        this.dispatcher = new Dispatcher(database_url, accepters);
    }
    /**
     * Set a route
     * @param options Route options
     */
    set(options) {
        const { endpoint: force_endpoint, method, get_keys: callback_keys, post_data: callback_data, on_error: callback_error, route } = options;
        if (Array.isArray(route)) {
            for (const r of route) {
                this.set(Object.assign({}, options, { route: r }));
            }
            return;
        }
        // Building function used as express callback
        const express_callback = (req, res) => {
            const container = {};
            // Gettings keys
            const keys = callback_keys(req, res, container);
            // If keys returned
            if (keys) {
                let endpoint = force_endpoint;
                // If the collection is a function, get the real collection
                if (typeof endpoint === 'function') {
                    endpoint = endpoint(req);
                }
                // Load all ids into dispatcher for endpoint
                const id = this.dispatcher.load(keys, endpoint);
                // Parallel flush
                this.dispatcher.pFlush(id)
                    // Final callback, for data
                    .then(data => {
                    callback_data(req, res, data, container);
                })
                    // Otherwise, if flush error
                    .catch(error => {
                    if (callback_error)
                        callback_error(req, res, error, container);
                });
            }
        };
        if (method === 'GET') {
            this.app.get(route, express_callback);
        }
        else if (method === "POST") {
            this.app.post(route, express_callback);
        }
        else if (method === "PUT") {
            this.app.put(route, express_callback);
        }
        else if (method === "DELETE") {
            this.app.delete(route, express_callback);
        }
        else {
            throw new Error("Unsupported method");
        }
    }
    listen(port = 3030, callback) {
        this.app.listen(port, callback);
    }
    setEndpoint(endpoint, fn) {
        this.dispatcher.set(endpoint, fn);
    }
}
exports.Routes = Routes;
