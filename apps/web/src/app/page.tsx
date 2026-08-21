import type { HealthResponse } from "@agent-coordinator/contracts";
import { Button } from "@/components/ui/button";

const placeholder: HealthResponse = { status: "ok" };

export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-svh max-w-2xl flex-col items-start justify-center gap-4 p-8">
      <h1 className="font-heading text-2xl font-semibold tracking-tight">Agent Coordinator</h1>
      <p className="text-muted-foreground text-sm">
        web app scaffold — status: {placeholder.status}
      </p>
      <Button>Button</Button>
    </main>
  );
}
