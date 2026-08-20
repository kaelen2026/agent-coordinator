import type { HealthResponse } from "@agent-coordinator/contracts";

const placeholder: HealthResponse = { status: "ok" };

export default function HomePage() {
  return (
    <main>
      <h1>Agent Coordinator</h1>
      <p>web app scaffold — status: {placeholder.status}</p>
    </main>
  );
}
