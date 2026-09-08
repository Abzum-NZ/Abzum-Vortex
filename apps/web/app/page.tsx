import Link from "next/link";
import { headers } from "next/headers";
import { serviceRegistry } from "../src/foundation";
import { identitySessionNavigationHint } from "./auth/_lib/session-request-state";

const layers = [
  {
    number: "01",
    title: "Stable contracts",
    text: "Organization, application, module, record type, definition and package identities.",
  },
  {
    number: "02",
    title: "Enforced boundaries",
    text: "Every service imports only declared, lower-level packages through public entry points.",
  },
  {
    number: "03",
    title: "One composition root",
    text: "The Next.js application is the only place where the sixteen runtime services are assembled.",
  },
];

export default async function FoundationPage() {
  const sessionState = identitySessionNavigationHint(await headers());
  const accountLink =
    sessionState === "verified"
      ? { href: "/signed-in", label: "Continue to Vortex" }
      : sessionState === "missing" || sessionState === "invalid"
        ? { href: "/auth/sign-in", label: "Secure sign in" }
        : { href: "/auth/sign-in", label: "Account access" };

  return (
    <main>
      <section className="hero">
        <div className="eyebrow">
          <span /> Phase 1 foundation
        </div>
        <h1>
          One workspace.
          <br />
          <em>Clear boundaries.</em>
        </h1>
        <p className="lede">
          Vortex now has a database-free foundation that makes the intended architecture visible,
          testable and difficult to bypass.
        </p>
        <div className="status">
          <span className="pulse" /> Foundation checks are wired into every production build
        </div>
      </section>

      <section className="layers" aria-label="Foundation layers">
        {layers.map((layer) => (
          <article key={layer.number}>
            <span className="number">{layer.number}</span>
            <h2>{layer.title}</h2>
            <p>{layer.text}</p>
          </article>
        ))}
      </section>

      <section className="services">
        <div>
          <p className="section-label">Runtime composition</p>
          <h2>
            Sixteen services,
            <br />
            one deliberate system.
          </h2>
        </div>
        <div className="service-grid">
          {serviceRegistry.map((service, index) => (
            <div className="service" key={service.key}>
              <span>{String(index + 1).padStart(2, "0")}</span>
              {service.key}
            </div>
          ))}
        </div>
      </section>

      <footer>
        <span>VORTEX</span>
        <Link href={accountLink.href}>{accountLink.label}</Link>
      </footer>
    </main>
  );
}
