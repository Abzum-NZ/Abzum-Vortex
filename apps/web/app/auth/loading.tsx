import { Card, CardContent } from "@vortex/ui/components/card";
import { Spinner } from "@vortex/ui/components/spinner";

export default function AuthLoading() {
  return (
    <main
      className="flex min-h-svh items-center justify-center p-4 sm:p-6 md:p-8"
      aria-busy="true"
      aria-live="polite"
    >
      <Card className="w-full max-w-md sm:max-w-lg border-border bg-card text-card-foreground shadow-sm">
        <CardContent className="flex items-center gap-4 text-muted-foreground py-6">
          <Spinner aria-hidden="true" />
          <p className="text-sm">Loading secure access…</p>
        </CardContent>
      </Card>
    </main>
  );
}
