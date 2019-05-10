"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : new P(function (resolve) { resolve(result.value); }).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
if (!window || !window.fetch) {
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
    load(ids) {
        let c = 0;
        let ok;
        const uniq_id = Math.random();
        for (const k of ids) {
            ok = false;
            for (const q of Object.values(this.pool)) {
                ok = q.push(k, uniq_id);
                if (ok) {
                    c++;
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
    remove(endpoint) {
        if (endpoint in this.pool) {
            delete this.pool[endpoint];
        }
        else {
            console.warn('Corresponding endpoint queue not found');
        }
    }
    set(endpoint, accept_function, packet_size = this.packet_size_per_queue) {
        if (endpoint in this.pool) {
            // Mise à jour de l'ancienne Queue
            if (accept_function)
                this.pool[endpoint].accept_fn = accept_function;
            if (packet_size > 0)
                this.pool[endpoint].packet_size = packet_size;
        }
        else {
            // Nouvelle Queue
            this.pool[endpoint] = new Queue(this.url + "/" + endpoint, accept_function, packet_size);
        }
    }
}
exports.default = Dispatcher;
class Queue {
    constructor(endpoint, accept_function, max_packet = 64) {
        this.pool = [];
        this.pool_by_id = {};
        this.endpoint = endpoint;
        this.max_packet = max_packet;
        this.accept_fn = accept_function;
    }
    push(key, unique_id) {
        const val = this.accept_fn(key);
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
