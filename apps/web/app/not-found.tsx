import Link from "next/link";
import { Alert, AlertDescription, AlertTitle } from "@vortex/ui/components/alert";
import { Button } from "@vortex/ui/components/button";

/**
 * The one not-found state for every address that resolves to nothing the person may open. It
 * states no reason beyond that, so it never confirms whether a tenant, organisation or
 * application exists.
 */
export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-svh w-full max-w-xl flex-col justify-center gap-4 p-6">
      <Alert variant="info">
        <AlertTitle>Page not found</AlertTitle>
        <AlertDescription>
          This address does not lead to a page you can open.
        </AlertDescription>
      </Alert>
      <div>
        <Button variant="outline" nativeButton={false} render={<Link href="/" />}>
          Go to the start page
        </Button>
      </div>
    </main>
  );
}
