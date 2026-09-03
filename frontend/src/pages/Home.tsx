// src/pages/Home.tsx
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Plus, Search, AlertCircle, LogIn, LogOut, Stamp, Map } from "lucide-react";
import { Link } from "react-router-dom";
import { createPageUrl } from "../utils";
import IDCard from "../components/IDCard";
import { listLostIDs, listFoundIDs } from "../lib/storage";
import { useAuth } from "../hooks/useAuth";
import { login, logout } from "../lib/auth";
import type { LostIDRecord, FoundIDRecord } from "../lib/storage";

export default function Home() {
  const [activeTab, setActiveTab] = useState<"lost" | "found">("lost");
  const { user, loading } = useAuth();

  const { data: lostIDs = [], isLoading: loadingLost } = useQuery<
    LostIDRecord[]
  >({
    queryKey: ["lostIDs"],
    queryFn: async () => listLostIDs(),
  });

  const { data: foundIDs = [], isLoading: loadingFound } = useQuery<
    FoundIDRecord[]
  >({
    queryKey: ["foundIDs"],
    queryFn: async () => listFoundIDs(),
  });

  return (
    <div className="min-h-screen bg-ink text-cream">
      {/* Header / hero */}
      <header className="border-b border-cream/10">
        <div className="max-w-6xl mx-auto px-6 md:px-10 pt-10 pb-8">
          <div className="flex items-start justify-between gap-6">
            <div className="flex items-start gap-4">
              <div className="shrink-0 rounded-sm bg-brass/15 border border-brass/40 p-2.5 mt-1">
                <Stamp className="h-6 w-6 text-brass" />
              </div>
              <div>
                <p className="font-mono text-xs uppercase tracking-[0.2em] text-brass mb-1">
                  Lost &amp; found registry
                </p>
                <h1 className="font-display text-4xl font-semibold text-cream leading-tight">
                  ID Finder
                </h1>
                <p className="text-cream/60 text-sm mt-2 max-w-md">
                  Report a lost ID, or hand in one you've found. We'll match
                  them and text both sides the moment a pair connects.
                </p>
              </div>
            </div>

            {!loading &&
              (user ? (
                <button
                  onClick={() => logout()}
                  className="shrink-0 flex items-center gap-2 rounded-sm border border-cream/25 px-4 py-2 text-sm text-cream/90 hover:bg-cream/10 transition-colors"
                >
                  <LogOut className="w-4 h-4" />
                  Sign out
                </button>
              ) : (
                <button
                  onClick={() => login()}
                  className="shrink-0 flex items-center gap-2 rounded-sm border border-cream/25 px-4 py-2 text-sm text-cream/90 hover:bg-cream/10 transition-colors"
                >
                  <LogIn className="w-4 h-4" />
                  Sign in
                </button>
              ))}
          </div>

          <div className="flex flex-wrap gap-3 mt-8">
            <Link to={createPageUrl("ReportLost")}>
              <Button className="bg-rust hover:bg-rust-dark border-rust-dark">
                <AlertCircle className="h-4 w-4 mr-2" />
                Report a lost ID
              </Button>
            </Link>
            <Link to={createPageUrl("ReportFound")}>
              <Button className="bg-forest hover:bg-forest-dark border-forest-dark">
                <Plus className="h-4 w-4 mr-2" />
                Report a found ID
              </Button>
            </Link>
            {/* Browsing the map needs no account, same as the listing below. */}
            <Link to={createPageUrl("Map")}>
              <Button
                variant="ghost"
                className="border border-cream/25 !text-cream/90 hover:!bg-cream/10"
              >
                <Map className="h-4 w-4 mr-2" />
                Browse the map
              </Button>
            </Link>
          </div>
        </div>
      </header>

      {/* Content */}
      <div className="max-w-6xl mx-auto px-6 md:px-10 py-10">
        {/* Tabs -- styled as two ticket-counter windows */}
        <div className="flex justify-center mb-10">
          <div className="flex w-full max-w-md rounded-sm border border-cream/15 bg-ink-light p-1">
            <button
              onClick={() => setActiveTab("lost")}
              className={`flex-1 rounded-sm py-2 text-sm font-medium font-mono uppercase tracking-wide transition-colors ${
                activeTab === "lost"
                  ? "bg-ink text-rust border border-rust/40"
                  : "text-cream/50 hover:text-cream/80"
              }`}
            >
              Lost ({lostIDs.length})
            </button>
            <button
              onClick={() => setActiveTab("found")}
              className={`flex-1 rounded-sm py-2 text-sm font-medium font-mono uppercase tracking-wide transition-colors ${
                activeTab === "found"
                  ? "bg-ink text-forest border border-forest/40"
                  : "text-cream/50 hover:text-cream/80"
              }`}
            >
              Found ({foundIDs.length})
            </button>
          </div>
        </div>

        {/* Lost IDs */}
        {activeTab === "lost" && (
          <>
            {loadingLost ? (
              <SkeletonGrid />
            ) : lostIDs.length === 0 ? (
              <EmptyState
                icon={<AlertCircle className="w-12 h-12 text-cream/25" />}
                title="No lost IDs reported"
                body="Be the first to report one."
                cta="Report a lost ID"
                to={createPageUrl("ReportLost")}
                accent="bg-rust hover:bg-rust-dark border-rust-dark"
              />
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
                {lostIDs.map((id) => (
                  <IDCard key={id.record_id} data={id} type="lost" />
                ))}
              </div>
            )}
          </>
        )}

        {/* Found IDs */}
        {activeTab === "found" && (
          <>
            {loadingFound ? (
              <SkeletonGrid />
            ) : foundIDs.length === 0 ? (
              <EmptyState
                icon={<Search className="w-12 h-12 text-cream/25" />}
                title="No found IDs yet"
                body="Help someone by reporting one."
                cta="Report a found ID"
                to={createPageUrl("ReportFound")}
                accent="bg-forest hover:bg-forest-dark border-forest-dark"
              />
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
                {foundIDs.map((id) => (
                  <IDCard key={id.record_id} data={id} type="found" />
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function SkeletonGrid() {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
      {[1, 2, 3].map((i) => (
        <div
          key={i}
          className="h-44 rounded-md bg-ink-light animate-pulse border border-cream/5"
        />
      ))}
    </div>
  );
}

function EmptyState({
  icon,
  title,
  body,
  cta,
  to,
  accent,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  cta: string;
  to: string;
  accent: string;
}) {
  return (
    <div className="text-center py-20">
      <div className="flex justify-center mb-4">{icon}</div>
      <h3 className="font-display text-lg font-medium text-cream mb-1">
        {title}
      </h3>
      <p className="text-cream/50 text-sm mb-6">{body}</p>
      <Link to={to}>
        <Button className={accent}>{cta}</Button>
      </Link>
    </div>
  );
}
