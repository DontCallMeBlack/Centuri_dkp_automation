export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  // Hosting cron routes own background writes. Rendering a page, running a
  // build, or starting a preview must never initialize a financial scheduler.
}
