import { useCallback, useEffect, useId, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import { motion, AnimatePresence } from "framer-motion";
import {
  Crosshair,
  MapPin,
  Type as TypeIcon,
  Loader2,
  Check,
  TriangleAlert,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import {
  buildMapStyle,
  isMapConfigured,
  registerPmtilesProtocol,
  DEFAULT_CENTER,
  DEFAULT_ZOOM,
} from "../lib/mapStyle";
import type { LocationInput } from "../lib/storage";

type Mode = "device" | "manual" | "geocoded";

type Props = {
  value: LocationInput | null;
  onChange: (value: LocationInput | null) => void;
  /** Tints the drop-pin marker to match the form it sits in. */
  accent?: "rust" | "forest";
};

const ACCENT_HEX = { rust: "#b5432f", forest: "#2f6f4e" } as const;

/**
 * The three-way location input.
 *
 * Two rules shape this component, both from hard experience rather than taste:
 *
 *  1. It must NEVER block submitting. Geolocation permission is denied often,
 *     it needs HTTPS (so it breaks on plain http://localhost in some
 *     browsers), and it can simply time out. None of that is an error state
 *     worth stopping a lost-ID report over -- the typed-area field stays
 *     usable at all times and the whole component is optional.
 *
 *  2. Last interaction wins. Tap "use my location" and then drag the pin, and
 *     the answer is the pin. Anything else means the form quietly submits a
 *     position the person did not choose.
 */
export default function LocationPicker({
  value,
  onChange,
  accent = "rust",
}: Props) {
  const mapConfigured = isMapConfigured();

  const [mode, setMode] = useState<Mode>("geocoded");
  const [locating, setLocating] = useState(false);
  const [geoError, setGeoError] = useState<string>("");
  const [address, setAddress] = useState("");

  const tablistId = useId();

  // --- device GPS ---------------------------------------------------------

  const useMyLocation = useCallback(() => {
    setGeoError("");

    if (!("geolocation" in navigator)) {
      setGeoError("This browser cannot share a location. Type an area instead.");
      return;
    }

    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        onChange({
          source: "device",
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy_m: Math.round(pos.coords.accuracy),
        });
      },
      (err) => {
        setLocating(false);
        // Deliberately phrased as a nudge, not a failure. A denial is a
        // completely normal choice and the form still works without it.
        setGeoError(
          err.code === err.PERMISSION_DENIED
            ? "Location access was declined. Drop a pin or type an area instead."
            : "Could not get a location just now. Drop a pin or type an area instead."
        );
      },
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 60_000 }
    );
  }, [onChange]);

  // --- typed area ---------------------------------------------------------

  useEffect(() => {
    if (mode !== "geocoded") return;
    const trimmed = address.trim();
    // Debounced so every keystroke does not churn the parent's form state.
    const t = setTimeout(() => {
      onChange(trimmed ? { source: "geocoded", address: trimmed } : null);
    }, 250);
    return () => clearTimeout(t);
  }, [address, mode, onChange]);

  return (
    <div className="rounded-md border border-ink/15 bg-white/40 overflow-hidden">
      <div
        role="tablist"
        aria-label="How to set the location"
        id={tablistId}
        className="flex bg-ink/[0.04] border-b border-ink/10"
      >
        <ModeTab
          active={mode === "geocoded"}
          onClick={() => setMode("geocoded")}
          icon={<TypeIcon className="h-3.5 w-3.5" />}
          label="Type an area"
        />
        {mapConfigured && (
          <ModeTab
            active={mode === "manual"}
            onClick={() => setMode("manual")}
            icon={<MapPin className="h-3.5 w-3.5" />}
            label="Drop a pin"
          />
        )}
        <ModeTab
          active={mode === "device"}
          onClick={() => setMode("device")}
          icon={<Crosshair className="h-3.5 w-3.5" />}
          label="Use my location"
        />
      </div>

      <div className="p-3">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={mode}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.15 }}
          >
            {mode === "geocoded" && (
              <div className="space-y-2">
                <Input
                  value={address}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                    setAddress(e.target.value)
                  }
                  placeholder="e.g. Kelham Island, Sheffield"
                  aria-label="Area or neighbourhood"
                />
                <p className="text-xs text-ink/50">
                  A neighbourhood, landmark or street name. Please leave off the
                  house number and the full postcode.
                </p>
              </div>
            )}

            {mode === "manual" && mapConfigured && (
              <PinDropMap
                accentHex={ACCENT_HEX[accent]}
                value={value}
                onPick={(lat, lng) => onChange({ source: "manual", lat, lng })}
              />
            )}

            {mode === "device" && (
              <div className="space-y-2">
                <button
                  type="button"
                  onClick={useMyLocation}
                  disabled={locating}
                  className="inline-flex items-center gap-2 rounded-sm border border-ink/20 bg-cream px-3 py-2 text-sm font-medium text-ink transition-colors hover:bg-paper disabled:opacity-60"
                >
                  {locating ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Crosshair className="h-4 w-4" />
                  )}
                  {locating ? "Finding you…" : "Use my current location"}
                </button>

                {geoError && (
                  <p className="flex items-start gap-1.5 text-xs text-ink/60">
                    <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-brass" />
                    {geoError}
                  </p>
                )}
              </div>
            )}
          </motion.div>
        </AnimatePresence>

        <Summary value={value} />
      </div>
    </div>
  );
}

function ModeTab({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`relative flex flex-1 items-center justify-center gap-1.5 px-2 py-2 text-xs font-medium transition-colors ${
        active ? "text-ink" : "text-ink/50 hover:text-ink/75"
      }`}
    >
      {icon}
      <span className="hidden sm:inline">{label}</span>
      {active && (
        <motion.span
          layoutId="location-mode-underline"
          className="absolute inset-x-1 bottom-0 h-0.5 rounded-full bg-ink"
          transition={{ type: "spring", stiffness: 400, damping: 32 }}
        />
      )}
    </button>
  );
}

function Summary({ value }: { value: LocationInput | null }) {
  if (!value) return null;

  const text =
    value.source === "geocoded"
      ? `Area: ${value.address}`
      : value.source === "device"
        ? `Your location, accurate to about ${value.accuracy_m}m`
        : `Pin dropped at ${value.lat.toFixed(4)}, ${value.lng.toFixed(4)}`;

  return (
    <div className="mt-3 flex items-start gap-1.5 border-t border-ink/10 pt-2.5">
      <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-forest" />
      <div className="min-w-0">
        <p className="truncate text-xs font-medium text-ink/80">{text}</p>
        <p className="mt-0.5 text-[11px] text-ink/45">
          Shown on the public map rounded to the nearest 250m. The exact spot is
          only ever shared once a match is confirmed.
        </p>
      </div>
    </div>
  );
}

/**
 * A small map you click to place a pin. The marker is draggable, because
 * getting a pin exactly right on the first tap is unlikely on a phone.
 */
function PinDropMap({
  accentHex,
  value,
  onPick,
}: {
  accentHex: string;
  value: LocationInput | null;
  onPick: (lat: number, lng: number) => void;
}) {
  const container = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markerRef = useRef<maplibregl.Marker | null>(null);

  // Held in a ref so the map's event handlers, which are registered once,
  // always reach the current callback without re-creating the map. Assigned in
  // an effect rather than during render -- mutating a ref while rendering is
  // not safe under concurrent rendering.
  const onPickRef = useRef(onPick);
  useEffect(() => {
    onPickRef.current = onPick;
  }, [onPick]);

  useEffect(() => {
    if (!container.current || mapRef.current) return;

    registerPmtilesProtocol();

    const map = new maplibregl.Map({
      container: container.current,
      style: buildMapStyle(),
      center: DEFAULT_CENTER,
      zoom: DEFAULT_ZOOM,
      attributionControl: { compact: true },
    });
    mapRef.current = map;

    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");

    const place = (lngLat: maplibregl.LngLat) => {
      if (!markerRef.current) {
        const marker = new maplibregl.Marker({
          color: accentHex,
          draggable: true,
        })
          .setLngLat(lngLat)
          .addTo(map);

        marker.on("dragend", () => {
          const p = marker.getLngLat();
          onPickRef.current(p.lat, p.lng);
        });

        markerRef.current = marker;
      } else {
        markerRef.current.setLngLat(lngLat);
      }
      onPickRef.current(lngLat.lat, lngLat.lng);
    };

    map.on("click", (e) => place(e.lngLat));

    return () => {
      markerRef.current?.remove();
      markerRef.current = null;
      map.remove();
      mapRef.current = null;
    };
    // Mount once. accentHex is read at creation and never changes for a given
    // form, so leaving it out avoids tearing the map down on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reflect a position chosen by another mode (GPS) onto this map, so
  // switching tabs shows the pin where it already is rather than an empty map.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !value || value.source === "geocoded") return;

    const lngLat: [number, number] = [value.lng, value.lat];
    if (markerRef.current) {
      markerRef.current.setLngLat(lngLat);
    } else {
      markerRef.current = new maplibregl.Marker({
        color: accentHex,
        draggable: true,
      })
        .setLngLat(lngLat)
        .addTo(map);
      markerRef.current.on("dragend", () => {
        const p = markerRef.current!.getLngLat();
        onPickRef.current(p.lat, p.lng);
      });
    }
    map.easeTo({ center: lngLat, zoom: Math.max(map.getZoom(), 13) });
  }, [value, accentHex]);

  return (
    <div className="space-y-2">
      <div
        ref={container}
        className="h-56 w-full overflow-hidden rounded-sm border border-ink/15"
      />
      <p className="text-xs text-ink/50">
        Tap the map to drop a pin, then drag it to fine-tune.
      </p>
    </div>
  );
}
