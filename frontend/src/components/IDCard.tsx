import {
  CreditCard,
  Car,
  Globe,
  GraduationCap,
  Briefcase,
  FileText,
  MapPin,
  Calendar,
} from "lucide-react";
import { format } from "date-fns";
import { motion } from "framer-motion";
import type { IDRecord } from "../lib/storage";

type Props = {
  data: IDRecord;
  type?: "lost" | "found";
  onClick?: () => void;
};

const idTypeIcons = {
  national_id: CreditCard,
  drivers_license: Car,
  passport: Globe,
  student_id: GraduationCap,
  work_id: Briefcase,
  other: FileText,
} as const;

const idTypeLabels: Record<string, string> = {
  national_id: "National ID",
  drivers_license: "Driver's license",
  passport: "Passport",
  student_id: "Student ID",
  work_id: "Work ID",
  other: "Other",
};

// The app's one signature element: each record renders as a claim-check
// ticket stub -- a perforated edge on the left, a rotated ink-stamp badge
// for status, and record data laid out like a real lost-property counter
// ticket. Lost tickets read in rust ink, found tickets in forest ink.
export default function IDCard({ data, type = "lost", onClick }: Props) {
  const idType = data.id_type as keyof typeof idTypeIcons;
  const Icon = idTypeIcons[idType] || FileText;
  const isLost = type === "lost";

  const isMatched = data.status === "matched";

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      whileHover={{ y: -3, transition: { duration: 0.15 } }}
      onClick={onClick}
      className={`relative overflow-hidden rounded-md bg-paper pl-6 pr-5 py-5 cursor-pointer border-l-4 ${
        isLost ? "border-l-rust" : "border-l-forest"
      } shadow-sm`}
    >
      {/* Perforated stub edge */}
      <div className="ticket-perforation absolute left-0 top-0 bottom-0 w-3" />

      {/* Rotated ink-stamp status badge */}
      <div
        className={`stamp-badge absolute -right-1 top-4 -rotate-6 rounded-sm border-2 px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-widest ${
          isMatched
            ? "border-forest text-forest-dark"
            : "border-brass text-ink/60"
        }`}
      >
        {isMatched ? "matched" : "pending"}
      </div>

      <div className="flex items-start gap-3 mb-4 pr-16">
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
          <div className="font-display font-semibold text-ink leading-tight truncate">
            {data.name_on_id}
          </div>
          <div className="font-mono text-[11px] uppercase tracking-wider text-ink/50 mt-0.5">
            {idTypeLabels[idType]}
            {data.id_number_hint ? ` \u00b7 \u2022\u2022\u2022${data.id_number_hint}` : ""}
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-1.5 border-t border-ink/10 pt-3">
        <div className="flex items-center gap-2 text-sm text-ink/70">
          <MapPin className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{data.location || "\u2014"}</span>
        </div>
        <div className="flex items-center gap-2 text-sm text-ink/50">
          <Calendar className="h-3.5 w-3.5 shrink-0" />
          <span className="font-mono text-xs">
            {format(new Date(data.created_at), "d MMM yyyy")}
          </span>
        </div>
      </div>
    </motion.div>
  );
}
