import { z } from "zod";

// Zod's parser generation probes `new Function`; a nonce CSP without `unsafe-eval` reports that
// caught probe as a violation. Only the development policy allows evaluation (React's overlay,
// proxy.ts); production and test do not, and the interpreter needs no code generation, as on the
// server (instrumentation.ts). Runs before any browser code constructs a schema.
z.config({ jitless: true });
