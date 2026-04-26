export default function HomePage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center p-8">
      <div className="text-center">
        <h1 className="font-display text-5xl text-campus-600 mb-4">
          CampusOS
        </h1>
        <p className="text-lg text-gray-500 mb-8">
          The School Operating System
        </p>
        <div className="inline-flex items-center gap-2 rounded-lg bg-campus-50 px-4 py-2 text-sm text-campus-500 font-medium">
          <span className="inline-block h-2 w-2 rounded-full bg-green-500" />
          Cycle 0 — Platform Foundation
        </div>
      </div>

      <div className="mt-16 grid grid-cols-1 md:grid-cols-3 gap-6 max-w-3xl w-full">
        <StatusCard
          title="API"
          endpoint="/api/v1/health"
          description="NestJS backend"
        />
        <StatusCard
          title="Database"
          endpoint="PostgreSQL 16"
          description="Platform schema"
        />
        <StatusCard
          title="Auth"
          endpoint="Keycloak"
          description="OIDC / SAML"
        />
      </div>
    </main>
  );
}

function StatusCard({
  title,
  endpoint,
  description,
}: {
  title: string;
  endpoint: string;
  description: string;
}) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-6">
      <h3 className="font-semibold text-campus-600 mb-1">{title}</h3>
      <p className="text-xs font-mono text-gray-400 mb-2">{endpoint}</p>
      <p className="text-sm text-gray-500">{description}</p>
    </div>
  );
}
