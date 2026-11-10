// A small stand-in for the Supabase JS client, backed by a real Postgres connection, for tests only.
// Each call runs in its own transaction as the given role with the given user id, so row-level security applies
// as it does behind Supabase's API. It implements only the query-builder calls the app uses.
const ident = s => '"' + String(s).replace(/"/g, '""') + '"';
function col(c) {
  const m = String(c).match(/^([a-z_]+)(->>?.+)?$/);
  if (!m) throw new Error('bad column ' + c);
  if (!m[2]) return ident(m[1]);
  return ident(m[1]) + m[2].replace(/->(>?)([A-Za-z0-9_]+)/g, (_, gt, k) => `->${gt}'${k}'`);
}
const val = v => v !== null && typeof v === 'object' ? JSON.stringify(v) : v === undefined ? null : v;

export function pgClient(pool, opts) {
  const { role, uid } = opts;
  async function run(sql, params) {
    const c = await pool.connect();
    try {
      await c.query('begin');
      await c.query(`set local role ${role}`);
      await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(uid ? { sub: uid, role } : { role })]);
      const r = await c.query(sql, params);
      await c.query('commit');
      return { data: r.rows, error: null };
    } catch (e) {
      await c.query('rollback').catch(() => {});
      return { data: null, error: { message: e.message, code: e.code } };
    } finally { c.release(); }
  }
  class Q {
    constructor(table) { this.t = table; this.op = 'select'; this.w = []; this.p = []; this.cols = '*'; this.ord = null; this.lim = null; this.off = 0; this.one = null; this.ret = null; }
    select(cols) { if (this.op === 'select') this.cols = cols || '*'; else this.ret = cols || '*'; return this; }
    eq(c, v) { this.p.push(v); this.w.push(`${col(c)} = $${this.p.length}`); return this; }
    order(c, o) { this.ord = `${col(c)} ${o && o.ascending === false ? 'desc' : 'asc'}`; return this; }
    limit(n) { this.lim = n; return this; }
    range(a, b) { this.off = a; this.lim = b - a + 1; return this; }
    maybeSingle() { this.one = 'maybe'; return this; }
    single() { this.one = 'single'; return this; }
    insert(rows) { this.op = 'insert'; this.rows = [].concat(rows); return this; }
    upsert(rows, o) { this.op = 'upsert'; this.rows = [].concat(rows); this.conf = (o && o.onConflict) || 'id'; this.ignore = !!(o && o.ignoreDuplicates); return this; }
    update(row) { this.op = 'update'; this.row = row; return this; }
    delete() { this.op = 'delete'; return this; }
    or(expr) { // supports "a.is.null,a.lt.<value>"
      const parts = expr.split(/,(?=[a-z_]+\.)/).map(x => {
        const [c, op, ...rest] = x.split('.'); const v = rest.join('.');
        if (op === 'is' && v === 'null') return `${col(c)} is null`;
        this.p.push(v); return `${col(c)} ${op === 'lt' ? '<' : op === 'gt' ? '>' : '='} $${this.p.length}`;
      });
      this.w.push('(' + parts.join(' or ') + ')'); return this;
    }
    sel(cols) { return cols === '*' ? '*' : cols.split(',').map(s => col(s.trim())).join(', '); }
    async exec() {
      const tbl = 'public.' + ident(this.t);
      let sql, params;
      if (this.op === 'select') {
        params = this.p;
        sql = `select ${this.sel(this.cols)} from ${tbl}${this.w.length ? ' where ' + this.w.join(' and ') : ''}${this.ord ? ' order by ' + this.ord : ''}${this.lim !== null ? ' limit ' + this.lim : ''}${this.off ? ' offset ' + this.off : ''}`;
      } else if (this.op === 'insert' || this.op === 'upsert') {
        if (!this.rows.length) return { data: [], error: null };
        params = [];
        const keys = [...new Set(this.rows.flatMap(r => Object.keys(r)))];
        const vals = this.rows.map(r => '(' + keys.map(k => { params.push(val(r[k])); return '$' + params.length; }).join(', ') + ')');
        sql = `insert into ${tbl} (${keys.map(ident).join(', ')}) values ${vals.join(', ')}`;
        if (this.op === 'upsert') {
          const conf = this.conf.split(',').map(s => s.trim()), upd = keys.filter(k => !conf.includes(k));
          sql += ` on conflict (${conf.map(ident).join(', ')}) do ` + (this.ignore || !upd.length ? 'nothing' : 'update set ' + upd.map(k => `${ident(k)} = excluded.${ident(k)}`).join(', '));
        }
        sql += ' returning ' + (this.ret ? this.sel(this.ret) : '*');
      } else if (this.op === 'update') {
        const keys = Object.keys(this.row), n = keys.length;
        params = keys.map(k => val(this.row[k])).concat(this.p);
        const where = this.w.length ? ' where ' + this.w.map(w => w.replace(/\$(\d+)/g, (_, i) => '$' + (Number(i) + n))).join(' and ') : '';
        sql = `update ${tbl} set ${keys.map((k, i) => `${ident(k)} = $${i + 1}`).join(', ')}${where} returning ${this.ret ? this.sel(this.ret) : '*'}`;
      } else {
        params = this.p;
        sql = `delete from ${tbl}${this.w.length ? ' where ' + this.w.join(' and ') : ''} returning ${this.ret ? this.sel(this.ret) : '*'}`;
      }
      const r = await run(sql, params);
      if (r.error) return r;
      if (this.one) {
        if (r.data.length > 1) return { data: null, error: { message: 'more than one row' } };
        if (!r.data.length && this.one === 'single') return { data: null, error: { message: 'no rows' } };
        return { data: r.data[0] || null, error: null };
      }
      return r;
    }
    then(ok, no) { return this.exec().then(ok, no); }
  }
  return {
    from: t => new Q(t),
    rpc: async (fn, args) => {
      const keys = Object.keys(args || {});
      return run(`select * from public.${ident(fn)}(${keys.map((k, i) => `${ident(k)} => $${i + 1}`).join(', ')})`, keys.map(k => args[k]));
    },
    raw: run,
  };
}
