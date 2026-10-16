export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  const { startDkpWeeklyResetScheduler } = await import('./lib/googleSheets');
  startDkpWeeklyResetScheduler();
}
