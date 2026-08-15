export function createPageUrl(page: "Home" | "ReportLost" | "ReportFound"): string {
  switch (page) {
    case "Home":
      return "/";
    case "ReportLost":
      return "/report-lost";
    case "ReportFound":
      return "/report-found";
  }
}
