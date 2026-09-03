export default function AuthLoading() {
  return (
    <main className="auth-page" aria-busy="true" aria-live="polite">
      <section className="auth-card auth-card-loading">
        <span className="auth-loading-mark" aria-hidden="true" />
        <p>Loading secure access…</p>
      </section>
    </main>
  );
}
