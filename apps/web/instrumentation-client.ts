import { z } from "zod";

// Zod's parser generation probes `new Function`; a nonce CSP without `unsafe-eval` reports that
// caught probe as a violation. The interpreter needs no code generation, as on the server
// (instrumentation.ts). Runs before any browser code constructs a schema.
z.config({ jitless: true });
