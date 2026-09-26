import { Card, CardContent } from "@vortex/ui/components/card";
import { Spinner } from "@vortex/ui/components/spinner";

export default function AuthLoading() {
  return (
    <main
      className="flex min-h-svh items-center justify-center p-6"
      aria-busy="true"
      aria-live="polite"
    >
      <Card className="w-full max-w-lg">
        <CardContent className="flex items-center gap-4 text-muted-foreground">
          <Spinner aria-hidden="true" />
          <p>Loading secure access…</p>
        </CardContent>
      </Card>
    </main>
  );
}
