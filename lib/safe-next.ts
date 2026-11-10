// Only same-site paths are allowed as a post-sign-in destination.
export function safeNext(v: string | null | undefined, fallback = '/app') {
  return v && v.startsWith('/') && !v.startsWith('//') && !v.startsWith('/\\') ? v : fallback;
}
