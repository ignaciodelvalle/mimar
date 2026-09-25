// The status chip of a denuncia — the web's `statusBadgeClass`, in the app's
// tokens. The WORD is the server's (`statusLabel`); only its colour family is
// decided here, through `statusTone`, so the list and the detail cannot draw
// one status two ways.

import type { MyWelfareReportStatusV1 } from "@dim/contract/api";
import { StyleSheet, Text } from "react-native";

import { FONTS } from "../ui/fonts";
import { COLORS, LABEL_TRACKING_EM, RADIUS, SPACE, TYPE } from "../ui/theme";

import { type StatusTone, statusTone } from "./my-reports-view-model";

const TONE_STYLE: Record<
  StatusTone,
  { borderColor: string; backgroundColor: string; color: string }
> = {
  ok: { borderColor: COLORS.okBorder, backgroundColor: COLORS.okSurface, color: COLORS.okInk },
  progress: {
    borderColor: COLORS.celeste100,
    backgroundColor: COLORS.focusRing,
    color: COLORS.accent,
  },
  review: {
    borderColor: COLORS.warnBorder,
    backgroundColor: COLORS.warnSurface,
    color: COLORS.warnInk,
  },
  muted: {
    borderColor: COLORS.borderStrong,
    backgroundColor: COLORS.stripe,
    color: COLORS.inkSoft,
  },
};

export function StatusBadge({ status, label }: { status: MyWelfareReportStatusV1; label: string }) {
  const tone = TONE_STYLE[statusTone(status)];
  return <Text style={[styles.badge, tone]}>{label}</Text>;
}

const styles = StyleSheet.create({
  badge: {
    alignSelf: "flex-start",
    fontFamily: FONTS.monoSemibold,
    fontSize: TYPE.xs,
    letterSpacing: TYPE.xs * LABEL_TRACKING_EM,
    textTransform: "uppercase",
    borderWidth: 1,
    borderRadius: RADIUS.chip,
    paddingHorizontal: SPACE.xs,
    paddingVertical: 2,
    overflow: "hidden",
  },
});
