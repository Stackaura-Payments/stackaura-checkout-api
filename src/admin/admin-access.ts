function splitAdminEmails(value: string | undefined) {
  return (value ?? '')
    .split(/[,\n;]+/)
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

export function resolvePlatformAdminEmails(
  env: NodeJS.ProcessEnv = process.env,
) {
  return Array.from(
    new Set([
      ...splitAdminEmails(env.STACKAURA_ADMIN_EMAILS),
      ...splitAdminEmails(env.ADMIN_EMAILS),
      ...splitAdminEmails(env.STACKAURA_ADMIN_EMAIL),
      ...splitAdminEmails(env.ADMIN_EMAIL),
    ]),
  );
}

export function isPlatformAdminEmail(
  email: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
) {
  const normalized = email?.trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  return resolvePlatformAdminEmails(env).includes(normalized);
}
