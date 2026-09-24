// Codemod: replace raw hex status tint values with ln-* token utilities
// Run: node scripts/codemod-status-tints.cjs
"use strict";
const fs = require("node:fs");

const files = [
  "app/denuncias/nueva/_components/Step5Contact.tsx",
  "app/denuncias/nueva/_components/Step4Subject.tsx",
  "app/denuncias/nueva/_components/Step3Where.tsx",
  "app/denuncias/nueva/_components/Step2Severity.tsx",
  "app/denuncias/codigo/[code]/page.tsx",
  "app/p/[publicToken]/sighting/PetSightingForm.tsx",
  "app/p/[publicToken]/sighting/page.tsx",
  "app/p/[publicToken]/page.tsx",
  "app/p/[publicToken]/encontre/page.tsx",
  "app/p/[publicToken]/encontre/FinderInPossessionForm.tsx",
  "app/adoptar/[petToken]/page.tsx",
  "app/(app)/transferencias/[transferToken]/page.tsx",
  "app/(app)/transferencias/[transferToken]/AcceptTransferActions.tsx",
  "app/(app)/transferencias/page.tsx",
  "app/(app)/mis-turnos/[appointmentToken]/page.tsx",
  "app/(app)/mis-turnos/[appointmentToken]/CancelButton.tsx",
  "app/(app)/mis-mascotas/[publicToken]/_tier2-public/Tier2PublicView.tsx",
  "app/(app)/mis-mascotas/[publicToken]/_share-libreta/ShareLibretaSheet.tsx",
  "app/(app)/mis-mascotas/[publicToken]/page.tsx",
  "app/(app)/mis-mascotas/[publicToken]/libreta/SharesManager.tsx",
  "app/(app)/mis-mascotas/[publicToken]/libreta/LibretaSanitariaView.tsx",
  "app/(app)/mis-mascotas/reclamar-dni/ClaimForm.tsx",
  "app/(app)/mis-mascotas/reclamar/ClaimWizard.tsx",
  "app/(app)/mis-mascotas/nueva/match/[matchedPetToken]/MatchConfirmationCardVecino.tsx",
  "app/(app)/mis-mascotas/postulaciones/page.tsx",
  "app/(app)/mis-mascotas/page.tsx",
  "components/ui/SuccessScreen.tsx",
  "components/ui/StatusFlag.tsx",
  "components/ui/Sheet.tsx",
  "app/(app)/inicio/_components/WorkflowList.tsx",
  "app/(app)/inicio/_components/RemindersSection.tsx",
  "components/ui/DocElements.tsx",
  "app/(app)/mis-mascotas/[publicToken]/devolucion/ReturnAcceptanceCard.tsx",
  "app/(app)/mis-mascotas/[publicToken]/devolucion/OwnerInitiateReturnForm.tsx",
  "app/(app)/mis-mascotas/[publicToken]/cartel/page.tsx",
  "app/(app)/mis-mascotas/[publicToken]/asistencia/ServiceDogForm.tsx",
  "app/(app)/mis-mascotas/[publicToken]/eventos/nuevo/mordedura/BiteForm.tsx",
  "app/(app)/mis-mascotas/[publicToken]/asistencia/presentar/page.tsx",
  "app/(app)/denuncias/[id]/page.tsx",
  "components/ui/Chip.tsx",
  "components/ui/Card.tsx",
  "components/ui/Badge.tsx",
  "app/(app)/mis-mascotas/[publicToken]/asistencia/page.tsx",
  "components/ui/Alert.tsx",
  "app/(app)/mis-mascotas/[publicToken]/eventos/nuevo/embarazo/page.tsx",
  "components/ServiceDogCredentialCard.tsx",
  "app/(app)/denuncias/mias/page.tsx",
  "components/PregnancyInProgressCard.tsx",
  "components/PppPublicBadge.tsx",
  "components/CasesWidget.tsx",
  "components/CaseBadge.tsx",
  "components/AchievementsSection.tsx",
  "components/AppointmentCard.tsx",
  "components/PppExportCabaButton.tsx",
  "components/PpPCard.tsx",
  "components/event/ConfidenceBadge.tsx",
  "components/event/ConfidenceBadge.test.tsx",
  "app/(app)/cuenta/verificar-dni/DniVerifyForm.tsx",
  "components/PetActionsMenu.tsx",
  "components/PetCard.tsx",
  "components/PetOpenCasesSection.tsx",
  "app/(app)/cuenta/upgrade/VetUpgradeForm.tsx",
  "app/(app)/cuenta/upgrade/page.tsx",
  "components/NotificationCard.tsx",
  "components/pet-profile/PetEmergencyCard.tsx",
  "app/(app)/cuenta/upgrade/OrgCreateForm.tsx",
  "app/(app)/cuenta/page.tsx",
  "components/pet-profile/PetVaccineReminders.tsx",
  "app/(app)/cuenta/renunciar/VetSelfResignForm.tsx",
  "app/(app)/cuenta/ofrecerme-como-transito/FosterVolunteerWizard.tsx",
  "components/pet-profile/PetTrackingPlaceholder.tsx",
  "app/(app)/cuenta/privacidad/PrivacyActions.tsx",
  "app/(app)/cuenta/memberships/page.tsx",
  "app/(app)/cuenta/transitos/propuestas/[proposalToken]/ProposalActions.tsx",
  "components/pet-profile/LostShareCard.tsx",
  "app/(app)/cuenta/desactivar/GovtSelfDeactivateForm.tsx",
  "components/pet-profile/LostLastSeenCard.tsx",
  "app/(app)/cuenta/solicitudes/page.tsx",
  "components/pet-profile/LostPublicCredential.tsx",
  "components/pet-profile/LostScanFeed.tsx",
  "app/(app)/cuenta/crear-consultorio/CrearConsultorioForm.tsx",
  "app/(app)/cuenta/editar/EditProfileForm.tsx",
];

// Pairs: [search-string, replacement-string]
// Order matters: more-specific first
const pairs = [
  // Tailwind arbitrary value classnames
  ["bg-[#eef6f0]", "bg-[var(--color-ln-ok-050)]"],
  ["bg-[#c8e2d2]", "bg-[var(--color-ln-ok-100)]"],
  ["bg-[#fdf2e0]", "bg-[var(--color-ln-warn-050)]"],
  ["bg-[#f0dcb4]", "bg-[var(--color-ln-warn-100)]"],
  ["bg-[#fbe9e6]", "bg-[var(--color-ln-err-050)]"],
  ["bg-[#f1c6bf]", "bg-[var(--color-ln-err-100)]"],
  ["bg-[#fdf6ea]", "bg-[var(--color-ln-warn-025)]"],
  ["border-[#c8e2d2]", "border-[var(--color-ln-ok-100)]"],
  ["border-[#eef6f0]", "border-[var(--color-ln-ok-050)]"],
  ["border-[#fdf2e0]", "border-[var(--color-ln-warn-050)]"],
  ["border-[#f0dcb4]", "border-[var(--color-ln-warn-100)]"],
  ["border-[#fbe9e6]", "border-[var(--color-ln-err-050)]"],
  ["border-[#f1c6bf]", "border-[var(--color-ln-err-100)]"],
  ["border-[#fdf6ea]", "border-[var(--color-ln-warn-025)]"],
  // Inline style object: background: "#hex"
  ['background: "#eef6f0"', 'background: "var(--color-ln-ok-050)"'],
  ['background: "#c8e2d2"', 'background: "var(--color-ln-ok-100)"'],
  ['background: "#fdf2e0"', 'background: "var(--color-ln-warn-050)"'],
  ['background: "#f0dcb4"', 'background: "var(--color-ln-warn-100)"'],
  ['background: "#fbe9e6"', 'background: "var(--color-ln-err-050)"'],
  ['background: "#f1c6bf"', 'background: "var(--color-ln-err-100)"'],
  ['background: "#fdf6ea"', 'background: "var(--color-ln-warn-025)"'],
  ['borderColor: "#c8e2d2"', 'borderColor: "var(--color-ln-ok-100)"'],
  ['borderColor: "#eef6f0"', 'borderColor: "var(--color-ln-ok-050)"'],
  ['borderColor: "#fdf2e0"', 'borderColor: "var(--color-ln-warn-050)"'],
  ['borderColor: "#f0dcb4"', 'borderColor: "var(--color-ln-warn-100)"'],
  ['borderColor: "#fbe9e6"', 'borderColor: "var(--color-ln-err-050)"'],
  ['borderColor: "#f1c6bf"', 'borderColor: "var(--color-ln-err-100)"'],
  ['borderColor: "#fdf6ea"', 'borderColor: "var(--color-ln-warn-025)"'],
  // Border shorthand string: "1px solid #hex"
  ['"1px solid #c8e2d2"', '"1px solid var(--color-ln-ok-100)"'],
  ['"1px solid #eef6f0"', '"1px solid var(--color-ln-ok-050)"'],
  ['"1px solid #fdf2e0"', '"1px solid var(--color-ln-warn-050)"'],
  ['"1px solid #f0dcb4"', '"1px solid var(--color-ln-warn-100)"'],
  ['"1px solid #fbe9e6"', '"1px solid var(--color-ln-err-050)"'],
  ['"1px solid #f1c6bf"', '"1px solid var(--color-ln-err-100)"'],
  ['"1px solid #fdf6ea"', '"1px solid var(--color-ln-warn-025)"'],
  // Dynamic border in template literal (p/[publicToken]/page.tsx)
  ['"#c8e2d2"', '"var(--color-ln-ok-100)"'],
  ['"#eef6f0"', '"var(--color-ln-ok-050)"'],
  ['"#fdf2e0"', '"var(--color-ln-warn-050)"'],
  ['"#f0dcb4"', '"var(--color-ln-warn-100)"'],
  ['"#fbe9e6"', '"var(--color-ln-err-050)"'],
  ['"#f1c6bf"', '"var(--color-ln-err-100)"'],
  ['"#fdf6ea"', '"var(--color-ln-warn-025)"'],
  // Single-quoted style values
  ["background: '#eef6f0'", "background: 'var(--color-ln-ok-050)'"],
  ["background: '#fbe9e6'", "background: 'var(--color-ln-err-050)'"],
  ["background: '#fdf2e0'", "background: 'var(--color-ln-warn-050)'"],
  // Bare hex in style objects (adoptar/page.tsx: background: "#eef6f0" already covered above)
];

function escapeForRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

let totalModified = 0;
const modifiedFiles = [];

for (const file of files) {
  if (!fs.existsSync(file)) {
    console.log("SKIP (not found):", file);
    continue;
  }

  let content = fs.readFileSync(file, "utf8");
  const original = content;

  for (const [search, replacement] of pairs) {
    // Use global replace with all occurrences
    while (content.includes(search)) {
      content = content.replace(search, replacement);
    }
  }

  if (content !== original) {
    fs.writeFileSync(file, content, "utf8");
    totalModified++;
    modifiedFiles.push(file);
  }
}

console.log(`\nModified ${totalModified} files:`);
modifiedFiles.forEach((f) => console.log(`  ${f}`));
