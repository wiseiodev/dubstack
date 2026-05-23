export function sanitizeRemoteUrl(url: string): string {
  return url
    .replace(/(https?:\/\/)([^/\s@]+)@/gi, '$1[REDACTED]@')
    .replace(
      /([?&](?:token|access_token|auth|key|secret)=)[^&\s]+/gi,
      '$1[REDACTED]',
    );
}
