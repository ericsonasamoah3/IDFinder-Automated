import { Routes, Route, Navigate } from "react-router-dom";
import { Toaster } from "sonner";

import Home from "./pages/Home";
import ReportLost from "./pages/ReportLost";
import ReportFound from "./pages/ReportFound";
import ProtectedRoute from "./components/ProtectedRoute";

export default function App() {

  return (
    <>
      <Toaster richColors />
      <Routes>
        <Route path="/" element={<Home />} />
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
