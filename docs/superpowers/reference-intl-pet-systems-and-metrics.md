# Reference — international pet-health systems & the MiMAR metrics catalog

> **Type:** Reference (no code) · **Date:** 2026-06-18 · Supports the metrics-IA handoff
> (`dim-interno:docs/superpowers-private/specs/archive/2026-06-18-metrics-ia-handoff-design.md` + Items 1–5).
> Read once before Items 2–4. Each metric in the item specs cites a code (A1, B2, C7…) defined here.

## Part 1 — How leading national systems work (and what we borrowed)

### Estonia — the most relevant model (mid-transition, like Argentina)
Estonia is moving from a **fragmented** model (registration scattered across 79 municipalities + three private/NGO registers: LLR/Lemmikloomaregister, a vets' register, the Kennel Union) to a **single central register** built at **PRIA** (the agency that runs the livestock register). From **1 June 2027** registration + microchipping of dogs, cats and ferrets becomes mandatory; the vet enters the chip at point of care; keeper-change updates are self-service; a **€12** state fee covers registration and each keeper change. Microchips must meet **ISO 11784/11785**. The framing — an animal "identifiable from birth to death" — is an event-sourcing/lifecycle mindset that maps directly onto MiMAR's `pet_registered → … → death_recorded` spine. Estonia has been **officially rabies-free since 2013** (achieved via EU-co-financed oral wildlife vaccination), reports disease through the EU's **ADIS** + **TRACES NT**, applies the **Animal Protection Act** (enforced by the Agriculture and Food Board / PTA), and gives strays a **14-day** minimum holding window before euthanasia. *Unverified/flagged by research: exact LLR launch date, the death-deregistration mechanics under the 2027 register, and Estonia-specific carcass rules under EC 1069/2009.*

### Sweden & Finland — mandatory central registers with death-deregistration
**Sweden** (Jordbruksverket) requires every dog ID-marked before 4 months and registered, with owners **legally obliged to report deaths, moves and exports** (deregistration); police/county boards/customs have register access. **Finland** (Ruokavirasto) opened a mandatory national Dog Registry to the public on **8 May 2023**: dogs born after 1 Jan 2023 must be microchipped (ISO 11784) and registered within 3 months; **fines apply for non-compliance**. The **death-reporting duty** is the direct inspiration for MiMAR metric **B5** (death→deregistration lag).

### New Zealand — annual re-registration as a data-freshness mechanism
The **National Dog Database** (Dept. of Internal Affairs; enforced by councils) under the **Dog Control Act 1996** requires dogs registered annually by 1 July ($300 fine for non-registration), microchipping since 2006, and classifies **dangerous/menacing** dogs nationally. The annual cycle effectively prunes deceased/lost animals — a different answer to the same freshness problem MiMAR addresses with events.

### United Kingdom — a cautionary fragmentation tale
Microchipping is mandatory for dogs (2016) and **cats (England, 10 June 2024)** under the Microchipping of Cats and Dogs (England) Regulations 2023, but spread across **~22–25 commercial DEFRA-compliant databases** that must cross-reference each other. The **XL Bully** ban (2023/2024) created an **Index of Exempted Dogs** — the closest analogue to MiMAR's dangerous-breed registry (metric **C7**). Strays are councils' responsibility; the **Dogs Trust survey** (~37–40k dogs handled, **~39% reunified**, ~33% to charities, ~1.5k put to sleep) is the source of the reunification benchmark (**D4**) — note these are *survey estimates*, not register output, precisely because there's no single register.

### EU pet passport & disease backbone
Non-commercial movement of dogs/cats/ferrets runs on **Reg (EU) 576/2013**: ISO 11784/11785 chip implanted **before** rabies vaccination, animal ≥12 weeks, 21-day validity wait. Disease notification runs on **ADIS** (under Animal Health Law 2016/429) hosted on **TRACES NT**. Carcass disposal across the EU/UK is governed by the **Animal By-Products Regulation (EC) 1069/2009** + implementing Reg (EU) 142/2011, with a pet-burial exemption — the legal backdrop for MiMAR's disposition metrics (**B2/B3**) alongside Argentina's Ley CABA 5470.

### The one finding that shaped metric selection
Across the UK and NSW, **official compliance percentages are essentially unpublished** — registries are too fragmented to compute them. MiMAR, event-sourced from day one, can produce microchip-penetration, disposal-traceability, ENO-SLA and registry-compliance rates as routine projections. That capability gap is the product wedge, and it's why Items 2–4 lean into compliance/traceability metrics rather than vanity counts.

### Research verification notes
- **Excluded as likely fabricated:** a set of striking "Sweden 2026" claims (real-time personnummer↔chip linkage, 48-hour filing deadline, automatic 2,500 SEK fine, ranger mobile-scanning) traced to a single non-authoritative blog; not corroborated by Jordbruksverket. Do not cite.
- **Approximate, not official:** the RSPCA "~85% of prosecutions" figure; UK stray counts (survey-derived).
- **Confirmed via primary sources:** PRIA 2027 register + €12 fee; Finland 2023 registry; EU 576/2013, 1069/2009, 2016/429; NZ Dog Control Act; UK 2023 microchip regs + XL Bully orders.

Primary sources: PRIA (pria.ee), Estonia PTA (pta.agri.ee), Riigi Teataja Animal Protection Act, PLoS NTD "Eliminating Rabies in Estonia" (PMC3289618), EU ADIS (food.ec.europa.eu), EUR-Lex 1069/2009 & 576/2013 & 2016/429, Ruokavirasto Dog Registry, Jordbruksverket dog register, DIA National Dog Database, legislation.gov.uk SI 2023/468, OLG NSW Pet Registry, Agriculture Victoria.

## Part 2 — The MiMAR metrics catalog (master list)

Every metric is a projection over the existing event log. Status: **now** = shippable with current events; **deferred** = needs a denominator/event we don't have. Item column = which spec implements it.

### A. Disease & surveillance
| Code | Metric | Source events | Status | Item |
|------|--------|---------------|--------|------|
| A1 | Rabies vaccination coverage | `vaccination_administered` (rabies, `next_due_at`) | now (live) | existing |
| A2 | Overdue-rabies count/rate | same | now | 5 (owner) / existing |
| A3 | Core-vaccine coverage index | `vaccination_administered` | now | existing |
| A4 | Outbreak-signal rate by `match_strength` | `outbreak_signal` | now (live) | existing |
| A5 | Symptom→signal latency | `symptom_observed`→`outbreak_signal` | now | 3 (stretch) |
| A6 | Reportable-disease incidence | `disease_reported`, `death_recorded.is_reportable` | now | 3 |
| A7 | **ENO-notification SLA** | `event_notification_outbox` (`eno_authority`) | now | 3 |
| A8 | **10-day rabies-observation compliance** | `rabies_observation_started/_ended` | now | 3 |
| A9 | Rabies-observation breaches | same | now | 3 |
| A10 | Lab-confirmation rate | `*.confirmed_by_lab` | now | 3 |
| A11 | Zoonosis geo-temporal clusters | `symptom_observed` + `death_recorded` | now | existing/3 |
| A12 | **AMR / antimicrobial density** | `medication_started` + classifier | now* | 3 |

\* A12 needs an `isAntimicrobial` classifier (Item 3 open question).

### B. Animal disposal & death
| Code | Metric | Source | Status | Item |
|------|--------|--------|--------|------|
| B1 | Mortality by cause | `death_recorded.cause` | now (live in analytics) | 2 |
| B2 | **Disposition-method mix** | `death_recorded.disposition_method` | now | 2 |
| B3 | **Traceable-disposal rate** | `death_recorded` (method+facility) | now | 2 |
| B4 | Unknown-disposition rate | `death_recorded` | now | 2 |
| B5 | Death→deregistration lag | `death_recorded` → terminal status | now-if-derivable | 2 |
| B7 | Disposal-context splits (vet-confirmed / at-clinic / private cremation) | `death_recorded` flags | now | 2 |
| B8 | Mortality clusters (map) | `death_recorded.location_point` | now | 2 |
| B9 | Reportable-death share | `death_recorded.is_reportable` + `disease_code` | now | 2 |
| B6 | Death under-reporting proxy | needs external population | **deferred** | — |

### C. Identification, registration & enforcement
| Code | Metric | Source | Status | Item |
|------|--------|--------|--------|------|
| C1 | **Microchip penetration** | `microchip_implanted` ÷ active pets | now | 4 |
| C2 | **ISO-validity rate** | `pet_identifications` | now | 4 |
| C5 | **Chip-fraud signal** | `microchip_replaced.reason` | now | 4 |
| C7 | **Dangerous-breed registry compliance** | `dangerous_breed_attested` ÷ PPP pets | now (graceful 0%) | 4 |
| C9 | Approval-queue throughput/latency | approval/audit events | now | existing (`/admin/sistema`) |
| C3 | Registration completeness vs external population | needs external denominator | **deferred** | — |

### D. Welfare & enforcement throughput
| Code | Metric | Source | Status | Item |
|------|--------|--------|--------|------|
| D1 | Welfare-report volume + triage SLA | `maltreatment_reported`/`abandonment_reported` | now (live) | existing |
| D2 | Abandonment rate | `abandonment_reported` | now | existing |
| D3 | Stray-intake throughput by reason | `shelter_intake_recorded` | now | existing |
| D4 | **Reunification rate + time-to-recovery** | lost episodes (`status_changed`) | now | 4 |
| D5 | **Seizures/decomisos** | `shelter_intake_recorded('seizure')` + decomiso cases | now | 4 |
| D6 | Custody-dispute volume/resolution | `custody_dispute_raised/_resolved` | now | existing |
| D7 | Lost-pet hotspots | `status_changed`→lost `location_point` | now (live) | existing |

### E. Population, adoption, owner & system health
| Code | Metric | Source | Status | Item |
|------|--------|--------|--------|------|
| E1 | Net population change | registrations − deaths − net lost | now | existing/analytics |
| E2 | Sterilization rate & vet throughput | `sterilization_performed` | now (live) | existing |
| E3 | Adoption funnel | application→resolved→finalized | now | existing (org) |
| E4 | Post-adoption check-in compliance | `post_adoption_checkin` | now | existing (org) |
| E5 | Adoption-reversal rate | `adoption_reversed` | now | existing |
| E6 | Credential-scan engagement | `credential_scanned` | now | 5 (owner) |
| E7 | Register freshness | last-update age per pet | now | existing (`/admin/sistema`) |
| E8 | k-anonymity suppression rate | aggregate cells suppressed | now | 3 (helper) |
| E9 | Event-outbox SLA | `event_notification_outbox` | now (live badge) | existing |
| E10 | PII-query audit volume | `auditLog` (`pii_queried`) | now (live) | existing |

### Legal anchors (Argentina) referenced by metrics
- **C1/C2 (microchip) have NO legal anchor** — corrected 2026-08-17. This line read "Ley Prov 14.107 (obligatory microchip)"; that statute admits a chip **or a tattoo** and only for PPP dogs, Ley CABA 4.078 requires a collar with chapa and never mentions a chip, and SENASA states no national electronic-ID regulation exists. C1/C2 measure adoption against a programmatic benchmark, not compliance with a norm.
- **Ley CABA 4078** / 14.107 (dangerous-breed registry) → C7
- **Ley CABA 5470** (cremation traceability) → B2/B3/B4
- **Ley Nacional 14.346** (cruelty) → D1/D5
- **Ord. CABA 41.831** art. 9 (10-day rabies observation) → A8/A9
- **Res. SENASA 580/2014, 284/2024, LSUCyF** (ENO vocab, ISO ID) → A6/A7/C2
