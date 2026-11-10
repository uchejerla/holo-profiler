// Wiring for server runs: the store, decrypted source secrets, and the source readers.
import 'server-only';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { env } from '@/lib/env';
import storeMod from '@/lib/core/store.js';
import cryptoMod from '@/lib/core/crypto.js';
import sourcesMod from '@/lib/core/sources.js';

const { createStore } = storeMod as any;
const { decrypt } = cryptoMod as any;
const { fetchRows } = sourcesMod as any;

export async function loadSource(ws: string, sourceId: string) {
  const admin = supabaseAdmin();
  const { data: source, error } = await admin.from('sources').select('id, workspace_id, kind, name, config').eq('workspace_id', ws).eq('id', sourceId).maybeSingle();
  if (error) throw new Error(error.message);
  if (!source) throw Object.assign(new Error('The data source was deleted'), { status: 400 });
  const { data: sec, error: e2 } = await admin.from('source_secrets').select('ciphertext').eq('source_id', sourceId).eq('workspace_id', ws).maybeSingle();
  if (e2) throw new Error(e2.message);
  if (!sec) throw Object.assign(new Error('The data source has no saved credentials'), { status: 400 });
  return { source, secret: decrypt(sec.ciphertext, env.encryptionKey(), sourceId) };
}

export function serverDeps() {
  const admin = supabaseAdmin();
  return {
    admin,
    loadSource,
    fetchRows,
    storeFor: (_ws: string) => createStore(admin),
    claimDue: async (nowIso: string, limit: number, lockIso: string) => {
      const { data, error } = await admin.rpc('claim_due_schedules', { p_now: nowIso, p_limit: limit, p_lock_until: lockIso });
      if (error) throw new Error(error.message);
      return data || [];
    },
    release: async (ws: string, ds: string) => { await admin.from('schedules').update({ lock_until: null }).eq('workspace_id', ws).eq('dataset_id', ds); },
  };
}
