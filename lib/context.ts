// Who is calling, and which workspace they act in. Every API route starts here.
import { supabaseServer } from '@/lib/supabase/server';
import { HttpError } from '@/lib/http';

export type Ctx = {
  sb: Awaited<ReturnType<typeof supabaseServer>>;
  user: { id: string; email: string | null };
  ws: { id: string; name: string; role: 'owner' | 'admin' | 'member' | 'viewer' };
};

export async function getCtx(): Promise<Ctx> {
  const sb = await supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) throw new HttpError(401, 'Sign in to continue', 'signed_out');
  // First workspace the user belongs to (each user gets a personal one at sign-up). Workspace switching can build on this.
  const { data, error } = await sb.from('workspace_members')
    .select('role, workspace:workspaces(id, name)').eq('user_id', user.id).order('created_at').limit(1).maybeSingle();
  if (error) throw new HttpError(500, error.message, 'unavailable');
  const w: any = data && (data as any).workspace;
  if (!w) throw new HttpError(403, 'Your account has no workspace yet', 'no_workspace');
  return { sb, user: { id: user.id, email: user.email ?? null }, ws: { id: w.id, name: w.name, role: (data as any).role } };
}

export function requireWriter(ctx: Ctx) {
  if (ctx.ws.role === 'viewer') throw new HttpError(403, 'Your role in this workspace is read-only', 'forbidden');
}
export function requireAdmin(ctx: Ctx) {
  if (ctx.ws.role !== 'owner' && ctx.ws.role !== 'admin') throw new HttpError(403, 'Only workspace owners and admins can manage data sources', 'forbidden');
}
