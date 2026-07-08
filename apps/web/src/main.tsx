import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { AuthProvider, useAuth } from "./lib/auth";
import { ErrorToastHost } from "./lib/errorToast";
import { RealtimeBridge } from "./lib/realtime";
import { AppLayout } from "./components/AppLayout";
import { LoginPage } from "./pages/LoginPage";
import { OperatorPage } from "./pages/OperatorPage";
import { QueuePage } from "./pages/QueuePage";
import { FloorPage } from "./pages/FloorPage";
import { ReportsPage } from "./pages/ReportsPage";
import { AdminPage } from "./pages/AdminPage";
import "./styles/app.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
      staleTime: 5000
    }
  }
});

function ProtectedRoutes() {
  const { session, loading } = useAuth();
  if (loading) return <div className="boot-screen">Loading ProcessGuard...</div>;
  if (!session) return <LoginPage />;
  const allowedPaths = new Set(session.nav.map((item) => item.path));
  const authorized = (element: React.ReactNode, path: string) => allowedPaths.has(path) ? element : <Navigate to={session.homePath} replace />;
  return (
    <AppLayout>
      <Routes>
        <Route path="/" element={<Navigate to={session.homePath} replace />} />
        <Route path="/login" element={<Navigate to={session.homePath} replace />} />
        <Route path="/operator" element={authorized(<OperatorPage />, "/operator")} />
        <Route path="/queue" element={authorized(<QueuePage />, "/queue")} />
        <Route path="/floor" element={authorized(<FloorPage />, "/floor")} />
        <Route path="/reports" element={authorized(<ReportsPage />, "/reports")} />
        <Route path="/admin" element={authorized(<AdminPage />, "/admin")} />
        <Route path="*" element={<Navigate to={session.homePath} replace />} />
      </Routes>
    </AppLayout>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <BrowserRouter>
          <RealtimeBridge />
          <ProtectedRoutes />
          <ErrorToastHost />
        </BrowserRouter>
      </AuthProvider>
    </QueryClientProvider>
  </React.StrictMode>
);
