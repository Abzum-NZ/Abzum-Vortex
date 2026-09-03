import Link from "next/link";
import { serviceRegistry } from "../src/foundation";

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

export default function FoundationPage() {
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
        <Link href="/auth/sign-in">Secure sign in</Link>
      </footer>
    </main>
  );
}
