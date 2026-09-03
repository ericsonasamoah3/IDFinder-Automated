import { Suspense, lazy } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import { Toaster } from "sonner";
import { Loader2 } from "lucide-react";

import Home from "./pages/Home";
import ReportLost from "./pages/ReportLost";
import ReportFound from "./pages/ReportFound";
import ProtectedRoute from "./components/ProtectedRoute";

// maplibre-gl is around a megabyte before compression. Loading it eagerly made
// every page -- including the listing, which has no map -- pay for it. Split
// out so it downloads only when a map is actually rendered.
const MapPage = lazy(() => import("./pages/MapPage"));

function MapFallback() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-ink">
      <Loader2 className="h-6 w-6 animate-spin text-cream/60" />
    </div>
  );
}

export default function App() {

  return (
    <>
      <Toaster richColors />
      <Routes>
        <Route path="/" element={<Home />} />
        {/* Public, like the listing. The map reads static files only -- it
            never touches the API -- so gating it would cost privacy nothing
            and cost people the ability to check for their ID. */}
        <Route
          path="/map"
          element={
            <Suspense fallback={<MapFallback />}>
              <MapPage />
            </Suspense>
          }
        />
        <Route
          path="/report-lost"
          element={
            <ProtectedRoute>
              <ReportLost />
            </ProtectedRoute>
          }
        />
        <Route
          path="/report-found"
          element={
            <ProtectedRoute>
              <ReportFound />
            </ProtectedRoute>
          }
        />
        <Route path="*" element={<Navigate to="/" />} />
      </Routes>
    </>
  );
}
