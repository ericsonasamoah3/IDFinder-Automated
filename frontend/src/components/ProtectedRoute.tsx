import { useEffect } from "react";
import { useAuth } from "../hooks/useAuth";
import { login } from "../lib/auth";
import { Loader2 } from "lucide-react";

export default function ProtectedRoute({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user, loading } = useAuth();
  useEffect(() => {
    if (!loading && !user) {
      login();
    }
  }, [user, loading]);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-ink">
        <Loader2 className="h-8 w-8 animate-spin text-brass" />
      </div>
    );
  }

  if (!user) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-ink">
        <Loader2 className="h-8 w-8 animate-spin text-brass" />
      </div>
    );
  }

  return <>{children}</>;
}
