import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import type { GeoJSONSource, MapGeoJSONFeature } from "maplibre-gl";
import type { FeatureCollection, Point } from "geojson";
import { useQuery } from "@tanstack/react-query";
import { motion, AnimatePresence } from "framer-motion";
import { Link } from "react-router-dom";
import { format } from "date-fns";
import {
  ArrowLeft,
  Crosshair,
  Maximize2,
  MapPin,
  X,
  Loader2,
  Info,
  CreditCard,
  Car,
  Globe,
  GraduationCap,
  Briefcase,
  FileText,
} from "lucide-react";
import { createPageUrl } from "../utils";
import { listLostIDs, listFoundIDs } from "../lib/storage";
import type { IDRecord } from "../lib/storage";
import {
  buildMapStyle,
  isMapConfigured,
  registerPmtilesProtocol,
  pinsUrl,
  PIN_COLORS,
  DEFAULT_CENTER,
  DEFAULT_ZOOM,
} from "../lib/mapStyle";

type Kind = "lost" | "found";
type Filter = "all" | Kind;

type PinCollection = FeatureCollection<
  Point,
  { record_id: string; record_type: Kind }
>;

const EMPTY: PinCollection = { type: "FeatureCollection", features: [] };

const ID_TYPE_ICONS = {
  national_id: CreditCard,
  drivers_license: Car,
  passport: Globe,
  student_id: GraduationCap,
  work_id: Briefcase,
  other: FileText,
} as const;

const ID_TYPE_LABELS: Record<string, string> = {
  national_id: "National ID",
  drivers_license: "Driver's licence",
  passport: "Passport",
  student_id: "Student ID",
  work_id: "Work ID",
  other: "Other",
};

/**
 * Fetches one of the two public pin files.
 *
 * These come straight off CloudFront as static objects -- no API Gateway, no
 * Lambda, no DynamoDB read. That is the whole reason the map is affordable to
 * leave open to the public, so it is worth not quietly "improving" later into
 * a query endpoint.
 */
async function fetchPins(kind: Kind): Promise<PinCollection> {
  const res = await fetch(pinsUrl(kind), { cache: "no-cache" });
  if (res.status === 403 || res.status === 404) {
    // The builder has not written this file yet -- a brand new deployment
    // with no reports. An empty map is the correct answer, not an error.
    return EMPTY;
  }
  if (!res.ok) throw new Error(`Could not load ${kind} pins (HTTP ${res.status})`);
  return (await res.json()) as PinCollection;
}

export default function MapPage() {
  const configured = isMapConfigured();

  const container = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const [mapReady, setMapReady] = useState(false);

  const [filter, setFilter] = useState<Filter>("all");
  const [selected, setSelected] = useState<IDRecord | null>(null);
  const [missingRecord, setMissingRecord] = useState(false);

  const lostPins = useQuery({
    queryKey: ["pins", "lost"],
    queryFn: () => fetchPins("lost"),
    enabled: configured,
    refetchInterval: 60_000, // matches the CDN's 60s TTL on pins/*
  });
  const foundPins = useQuery({
    queryKey: ["pins", "found"],
    queryFn: () => fetchPins("found"),
    enabled: configured,
    refetchInterval: 60_000,
  });

  // The pin files carry only record_id and record_type by design -- no names,
  // no locations, nothing identifying. Everything shown in the detail panel
  // comes from the ordinary public listing instead.
  const lostRecords = useQuery({ queryKey: ["lostIDs"], queryFn: listLostIDs });
  const foundRecords = useQuery({ queryKey: ["foundIDs"], queryFn: listFoundIDs });

  const recordsById = useMemo(() => {
    const map = new Map<string, IDRecord>();
    for (const r of lostRecords.data ?? []) map.set(r.record_id, r);
    for (const r of foundRecords.data ?? []) map.set(r.record_id, r);
    return map;
  }, [lostRecords.data, foundRecords.data]);

  // The map's click handlers are registered once, on load, so they would
  // otherwise close over the very first (empty) record index forever. A ref
  // keeps them reading the current one without re-creating the map. Assigned
  // in an effect rather than during render -- mutating a ref while rendering
  // is not safe under concurrent rendering.
  const recordsByIdRef = useRef(recordsById);
  useEffect(() => {
    recordsByIdRef.current = recordsById;
  }, [recordsById]);

  const counts = {
    lost: lostPins.data?.features.length ?? 0,
    found: foundPins.data?.features.length ?? 0,
  };

  // --- map lifecycle ------------------------------------------------------

  useEffect(() => {
    if (!configured || !container.current || mapRef.current) return;

    registerPmtilesProtocol();

    const map = new maplibregl.Map({
      container: container.current,
      style: buildMapStyle(),
      center: DEFAULT_CENTER,
      zoom: DEFAULT_ZOOM,
      attributionControl: { compact: true },
    });
    mapRef.current = map;

    map.addControl(
      new maplibregl.NavigationControl({ showCompass: false }),
      "bottom-right"
    );

    map.on("load", () => {
      for (const kind of ["lost", "found"] as const) {
        map.addSource(kind, {
          type: "geojson",
          data: EMPTY,
          // On from day one, not retrofitted: a few hundred pins in one city
          // are unreadable without it, and adding it later means rewriting
          // every click handler to deal with cluster features.
          cluster: true,
          clusterRadius: 50,
          clusterMaxZoom: 14,
        });

        map.addLayer({
          id: `${kind}-clusters`,
          type: "circle",
          source: kind,
          filter: ["has", "point_count"],
          paint: {
            "circle-color": PIN_COLORS[kind],
            "circle-opacity": 0.9,
            "circle-stroke-width": 2,
            "circle-stroke-color": "#f3efe3",
            "circle-radius": [
              "step",
              ["get", "point_count"],
              16, 10, 22, 50, 30,
            ],
          },
        });

        map.addLayer({
          id: `${kind}-cluster-count`,
          type: "symbol",
          source: kind,
          filter: ["has", "point_count"],
          layout: {
            "text-field": ["get", "point_count_abbreviated"],
            "text-font": ["Noto Sans Regular"],
            "text-size": 12,
          },
          paint: { "text-color": "#f3efe3" },
        });

        map.addLayer({
          id: `${kind}-point`,
          type: "circle",
          source: kind,
          filter: ["!", ["has", "point_count"]],
          paint: {
            "circle-color": PIN_COLORS[kind],
            "circle-radius": 7,
            "circle-stroke-width": 2.5,
            "circle-stroke-color": "#f3efe3",
          },
        });

        map.on("click", `${kind}-clusters`, (e) => {
          const feature = e.features?.[0];
          if (!feature) return;
          const source = map.getSource(kind) as GeoJSONSource;
          const clusterId = feature.properties?.cluster_id as number;
          source.getClusterExpansionZoom(clusterId).then((zoom) => {
            map.easeTo({
              center: (feature.geometry as Point).coordinates as [
                number,
                number,
              ],
              zoom,
            });
          });
        });

        map.on("click", `${kind}-point`, (e) => {
          const feature = e.features?.[0] as MapGeoJSONFeature | undefined;
          const recordId = feature?.properties?.record_id as string | undefined;
          if (!recordId) return;

          const record = recordsByIdRef.current.get(recordId);
          setSelected(record ?? null);
          // A pin whose record is not in the listing means the two are briefly
          // out of step -- the pin file is cached for 60s. Say so rather than
          // opening an empty panel.
          setMissingRecord(!record);

          map.easeTo({
            center: (feature!.geometry as Point).coordinates as [
              number,
              number,
            ],
            zoom: Math.max(map.getZoom(), 13),
            offset: [0, -80],
          });
        });

        for (const layer of [`${kind}-clusters`, `${kind}-point`]) {
          map.on("mouseenter", layer, () => {
            map.getCanvas().style.cursor = "pointer";
          });
          map.on("mouseleave", layer, () => {
            map.getCanvas().style.cursor = "";
          });
        }
      }

      setMapReady(true);
    });

    return () => {
      map.remove();
      mapRef.current = null;
      setMapReady(false);
    };
  }, [configured]);

  // --- feed data in -------------------------------------------------------

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    (map.getSource("lost") as GeoJSONSource | undefined)?.setData(
      lostPins.data ?? EMPTY
    );
  }, [lostPins.data, mapReady]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    (map.getSource("found") as GeoJSONSource | undefined)?.setData(
      foundPins.data ?? EMPTY
    );
  }, [foundPins.data, mapReady]);

  // --- filter -------------------------------------------------------------

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;

    for (const kind of ["lost", "found"] as const) {
      const visible = filter === "all" || filter === kind;
      for (const suffix of ["clusters", "cluster-count", "point"]) {
        map.setLayoutProperty(
          `${kind}-${suffix}`,
          "visibility",
          visible ? "visible" : "none"
        );
      }
    }
  }, [filter, mapReady]);

  // --- controls -----------------------------------------------------------

  const fitToPins = useCallback(() => {
    const map = mapRef.current;
    if (!map) return;

    const features = [
      ...(filter !== "found" ? (lostPins.data?.features ?? []) : []),
      ...(filter !== "lost" ? (foundPins.data?.features ?? []) : []),
    ];
    if (features.length === 0) {
      map.easeTo({ center: DEFAULT_CENTER, zoom: DEFAULT_ZOOM });
      return;
    }

    const bounds = new maplibregl.LngLatBounds();
    for (const f of features) {
      bounds.extend(f.geometry.coordinates as [number, number]);
    }
    map.fitBounds(bounds, { padding: 80, maxZoom: 14, duration: 700 });
  }, [filter, lostPins.data, foundPins.data]);

  const locateMe = useCallback(() => {
    const map = mapRef.current;
    if (!map || !("geolocation" in navigator)) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        map.easeTo({
          center: [pos.coords.longitude, pos.coords.latitude],
          zoom: 13,
        });
      },
      // Silent on failure: this is a convenience button, and a denied
      // permission is not something to interrupt someone with.
      () => {}
    );
  }, []);

  if (!configured) return <SetupNotice />;

  const loading = lostPins.isLoading || foundPins.isLoading;
  const loadError = lostPins.error ?? foundPins.error;

  return (
    <div className="relative h-screen w-full overflow-hidden bg-ink">
      <div ref={container} className="absolute inset-0" />

      {/* Top bar */}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-10 bg-gradient-to-b from-ink/85 to-transparent px-4 pb-10 pt-4 sm:px-6">
        <div className="pointer-events-auto mx-auto flex max-w-5xl flex-wrap items-center gap-3">
          <Link
            to={createPageUrl("Home")}
            className="inline-flex items-center gap-2 rounded-sm px-2 py-1.5 text-sm text-cream/80 transition-colors hover:text-cream"
          >
            <ArrowLeft className="h-4 w-4" />
            Back
          </Link>

          <h1 className="font-display text-lg font-semibold text-cream">
            Where IDs turn up
          </h1>

          <div className="ml-auto flex items-center gap-2">
            <FilterTabs filter={filter} setFilter={setFilter} counts={counts} />
          </div>
        </div>
      </div>

      {/* Side controls */}
      <div className="absolute bottom-28 right-3 z-10 flex flex-col gap-2 sm:bottom-32">
        <ControlButton onClick={locateMe} label="Centre on my location">
          <Crosshair className="h-4 w-4" />
        </ControlButton>
        <ControlButton onClick={fitToPins} label="Zoom out to all pins">
          <Maximize2 className="h-4 w-4" />
        </ControlButton>
      </div>

      {/* Status pill */}
      <AnimatePresence>
        {(loading || loadError) && (
          <motion.div
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            className="absolute left-1/2 top-20 z-10 -translate-x-1/2"
          >
            <div className="flex items-center gap-2 rounded-full bg-paper px-3 py-1.5 text-xs font-medium text-ink shadow-lg">
              {loadError ? (
                <>
                  <Info className="h-3.5 w-3.5 text-rust" />
                  {(loadError as Error).message}
                </>
              ) : (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Loading pins…
                </>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Privacy note + legend */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 bg-gradient-to-t from-ink/85 to-transparent px-4 pb-4 pt-10 sm:px-6">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-4 gap-y-1.5">
          <Legend kind="lost" label="Lost" />
          <Legend kind="found" label="Found" />
          <p className="text-[11px] text-cream/50">
            Pins are rounded to the nearest 250m. Exact locations are shared
            only with a matched pair.
          </p>
        </div>
      </div>

      <AnimatePresence>
        {(selected || missingRecord) && (
          <DetailPanel
            record={selected}
            missing={missingRecord}
            onClose={() => {
              setSelected(null);
              setMissingRecord(false);
            }}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

function FilterTabs({
  filter,
  setFilter,
  counts,
}: {
  filter: Filter;
  setFilter: (f: Filter) => void;
  counts: { lost: number; found: number };
}) {
  const options: { value: Filter; label: string; count: number }[] = [
    { value: "all", label: "All", count: counts.lost + counts.found },
    { value: "lost", label: "Lost", count: counts.lost },
    { value: "found", label: "Found", count: counts.found },
  ];

  return (
    <div className="flex rounded-full bg-ink/70 p-1 backdrop-blur-sm ring-1 ring-cream/15">
      {options.map((o) => {
        const active = filter === o.value;
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => setFilter(o.value)}
            aria-pressed={active}
            className={`relative rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
              active ? "text-ink" : "text-cream/70 hover:text-cream"
            }`}
          >
            {active && (
              <motion.span
                layoutId="map-filter-pill"
                className="absolute inset-0 rounded-full bg-cream"
                transition={{ type: "spring", stiffness: 400, damping: 34 }}
              />
            )}
            <span className="relative flex items-center gap-1.5">
              {o.label}
              <span
                className={`font-mono text-[10px] ${
                  active ? "text-ink/55" : "text-cream/45"
                }`}
              >
                {o.count}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

function ControlButton({
  onClick,
  label,
  children,
}: {
  onClick: () => void;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className="rounded-sm bg-cream p-2 text-ink shadow-lg transition-colors hover:bg-paper"
    >
      {children}
    </button>
  );
}

function Legend({ kind, label }: { kind: Kind; label: string }) {
  return (
    <span className="flex items-center gap-1.5 text-[11px] font-medium text-cream/75">
      <span
        className="h-2.5 w-2.5 rounded-full ring-2 ring-cream/70"
        style={{ backgroundColor: PIN_COLORS[kind] }}
      />
      {label}
    </span>
  );
}

/**
 * The record behind a pin, rendered as a claim-check stub so it reads as the
 * same object as the cards on the home page.
 */
function DetailPanel({
  record,
  missing,
  onClose,
}: {
  record: IDRecord | null;
  missing: boolean;
  onClose: () => void;
}) {
  // Escape closes it, which is the one keyboard affordance a floating panel
  // over a map really needs.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const isLost = record?.record_type === "lost";
  const Icon = record
    ? (ID_TYPE_ICONS[record.id_type as keyof typeof ID_TYPE_ICONS] ?? FileText)
    : FileText;

  return (
    <motion.aside
      role="dialog"
      aria-label="Report details"
      initial={{ opacity: 0, y: 24 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 24 }}
      transition={{ type: "spring", stiffness: 320, damping: 32 }}
      className="absolute bottom-20 left-1/2 z-20 w-[min(26rem,calc(100vw-2rem))] -translate-x-1/2 sm:bottom-24"
    >
      <div
        className={`relative overflow-hidden rounded-md bg-paper py-5 pl-6 pr-5 shadow-2xl ${
          record ? (isLost ? "border-l-4 border-l-rust" : "border-l-4 border-l-forest") : ""
        }`}
      >
        <div className="ticket-perforation absolute bottom-0 left-0 top-0 w-3" />

        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="absolute right-3 top-3 rounded-sm p-1 text-ink/40 transition-colors hover:bg-ink/5 hover:text-ink"
        >
          <X className="h-4 w-4" />
        </button>

        {missing || !record ? (
          <div className="pr-8">
            <p className="font-display text-sm font-semibold text-ink">
              This pin is still catching up
            </p>
            <p className="mt-1 text-xs text-ink/60">
              The pin files are cached for a minute, so a very new or
              just-matched report can briefly show here without its details.
              Try again shortly.
            </p>
          </div>
        ) : (
          <>
            <div className="mb-4 flex items-start gap-3 pr-8">
              <div
                className={`shrink-0 rounded-sm p-2 ${
                  isLost ? "bg-rust/10" : "bg-forest/10"
                }`}
              >
                <Icon
                  className={`h-5 w-5 ${isLost ? "text-rust" : "text-forest"}`}
                />
              </div>
              <div className="min-w-0">
                <div className="truncate font-display font-semibold leading-tight text-ink">
                  {record.name_on_id}
                </div>
                <div className="mt-0.5 font-mono text-[11px] uppercase tracking-wider text-ink/50">
                  {ID_TYPE_LABELS[record.id_type] ?? record.id_type} &middot;{" "}
                  {isLost ? "reported lost" : "handed in"}
                </div>
              </div>
            </div>

            <div className="flex flex-col gap-1.5 border-t border-ink/10 pt-3">
              <div className="flex items-center gap-2 text-sm text-ink/70">
                <MapPin className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">{record.location || "—"}</span>
              </div>
              <div className="font-mono text-xs text-ink/50">
                {format(new Date(record.created_at), "d MMM yyyy")}
              </div>
              {record.description && (
                <p className="mt-1 line-clamp-3 text-xs text-ink/60">
                  {record.description}
                </p>
              )}
            </div>
          </>
        )}
      </div>
    </motion.aside>
  );
}

/**
 * Shown when VITE_MAP_CDN is unset -- a fresh clone, or a deploy where the
 * basemap has not been uploaded yet. Explaining the two steps here is far
 * more useful than a blank grey rectangle.
 */
function SetupNotice() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-ink px-4">
      <div className="max-w-md rounded-md bg-paper p-6 text-ink shadow-xl">
        <h1 className="font-display text-xl font-semibold">Map not configured</h1>
        <p className="mt-2 text-sm text-ink/70">
          <code className="font-mono text-xs">VITE_MAP_CDN</code> is not set, so
          there is nowhere to load tiles from. Everything else in the app works
          without it.
        </p>
        <ol className="mt-4 list-decimal space-y-1.5 pl-5 text-sm text-ink/70">
          <li>
            Run <code className="font-mono text-xs">terraform apply</code>, then
            copy <code className="font-mono text-xs">map_cdn_url</code> from the
            outputs into your <code className="font-mono text-xs">.env</code>.
          </li>
          <li>
            Upload a city or county basemap extract once, by hand:
            <code className="mt-1 block font-mono text-[11px]">
              aws s3 cp basemap.pmtiles s3://&lt;map bucket&gt;/basemap.pmtiles
            </code>
          </li>
        </ol>
        <Link
          to={createPageUrl("Home")}
          className="mt-5 inline-flex items-center gap-2 text-sm font-medium text-rust hover:underline"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to home
        </Link>
      </div>
    </div>
  );
}
