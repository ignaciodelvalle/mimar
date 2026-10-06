import { Icon } from "@/components/Icon";
import { PublicCarnetTurn } from "@/components/credential/PublicCarnetTurn";
import { PublicDocumentBand } from "@/components/credential/PublicDocumentBand";
import { LnButton } from "@/components/ui/Button";
import { PET_SITUATIONS } from "@/lib/ui/pet-situation";
import { situationLabelForSex } from "@/lib/utils/format";
import { chromeForSurface } from "@dim/contract/credential";
import { type DerivedPetActions, derivePetActions } from "@dim/contract/reference";

import type { FichaFixture } from "./ficha-fixtures";

const CHROME = chromeForSurface("owner");

function Photo({ letter }: { letter: string }) {
  return (
    <div className="pc-photo-mount">
      <div className="pc-photo-placeholder">
        <span className="pc-photo-placeholder-initial">{letter}</span>
      </div>
    </div>
  );
}

function Qr({ svg, name }: { svg: string; name: string }) {
  return (
    <div className="pc-qr-mount" data-slot="qr" role="img" aria-label={`Código QR de ${name}`}>
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: server-generated QR SVG from the qrcode package, fixture URL only. */}
      <span aria-hidden="true" dangerouslySetInnerHTML={{ __html: svg }} />
    </div>
  );
}

function Ping() {
  return (
    <div className="pc-qr-mount" data-slot="ping" aria-hidden="true">
      <div className="pc-ping">
        <span className="pc-ping-grid" />
        <span className="pc-ping-dot" />
        <span className="pc-ping-ring" />
      </div>
    </div>
  );
}

function Spark({ weights }: { weights: number[] }) {
  const min = Math.min(...weights);
  const max = Math.max(...weights);
  const span = max - min || 1;
  const pts = weights
    .map((w, i) => {
      const x = (i / (weights.length - 1)) * 100;
      const y = 32 - ((w - min) / span) * 26;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg className="fp-spark" viewBox="0 0 100 36" role="img" aria-label="Peso, últimos registros">
      <title>Peso, últimos registros</title>
      <polyline
        points={pts}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

function Front({ fixture, qrSvg }: { fixture: FichaFixture; qrSvg: string }) {
  const situation = fixture.situation === "al-dia" ? null : PET_SITUATIONS[fixture.situation];
  const loud = situation ? situationLabelForSex(situation.label, fixture.sex) : null;
  return (
    <>
      <div className="pc-id" data-cell={fixture.cell}>
        <Photo letter={fixture.name.slice(0, 1)} />
        <div className="pc-id-copy">
          <h2 className="m-0 font-ln-serif text-xl text-ln-ink">{fixture.name}</h2>
          <p className="pc-id-token">{fixture.token}</p>
        </div>
        {fixture.cell === "qr" ? <Qr svg={qrSvg} name={fixture.name} /> : null}
        {fixture.cell === "ping" ? <Ping /> : null}
      </div>
      <div className="pc-name">
        <p className="pc-name-meta">{fixture.meta}</p>
      </div>
      {loud && situation ? (
        <div className="pc-chips">
          <span className="pc-sit-chip" role={situation.key === "perdida" ? "alert" : undefined}>
            <Icon name={situation.icon} size="sm" decorative />
            {loud}
          </span>
        </div>
      ) : null}
      {fixture.notices.map((n) => (
        <p className="fp-notice" key={n.label}>
          <Icon name={n.icon} size="sm" decorative />
          <span>{n.label}</span>
        </p>
      ))}
      {fixture.compliance ? (
        <section className="fp-sec">
          <h3 className="fp-eyebrow">Cumplimiento</h3>
          <p className="fp-summary">{fixture.compliance.summary}</p>
          <dl className="fp-rows">
            {fixture.compliance.rows.map((row) => (
              <div key={row.dt}>
                <dt>{row.dt}</dt>
                <dd>{row.dd}</dd>
              </div>
            ))}
          </dl>
          {fixture.nextDue ? <p className="fp-next">{fixture.nextDue}</p> : null}
        </section>
      ) : fixture.nextDue ? (
        <p className="fp-next fp-sec">{fixture.nextDue}</p>
      ) : null}
      {fixture.firstSteps ? (
        <section className="fp-sec">
          <h3 className="fp-eyebrow">Primeros pasos</h3>
          <ul className="fp-steps">
            {fixture.firstSteps.map((step) => (
              <li key={step.label} className="fp-step" data-done={step.done ? "true" : "false"}>
                <span className="fp-tick" aria-hidden="true" />
                {step.label}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}

function Back({ fixture }: { fixture: FichaFixture }) {
  return (
    <div className="fp-lib">
      <div className="fp-lenses" aria-hidden="true">
        <span className="fp-lens" data-on="true">
          Todo
        </span>
        <span className="fp-lens">Vacunas</span>
      </div>
      {fixture.libreta.length === 0 ? (
        <p className="fp-empty">Todavía no hay registros en la libreta.</p>
      ) : (
        fixture.libreta.map((row) => (
          <div
            className="fp-entry"
            data-upcoming={row.upcoming ? "true" : undefined}
            key={row.what}
          >
            <span>
              {row.upcoming ? <span>Próximo</span> : null}
              <b>{row.what}</b>
              {row.who}
            </span>
            <span>{row.when}</span>
          </div>
        ))
      )}
      {fixture.weights ? <Spark weights={fixture.weights} /> : null}
    </div>
  );
}

function Actions({ derived }: { derived: DerivedPetActions }) {
  return (
    <div className="fp-actions">
      <div className="fp-primary">
        {derived.primary.map((action) => (
          <LnButton
            key={action.id}
            variant="ghost"
            size="sm"
            disabled={action.state.kind === "inert"}
            title={action.caption ?? action.hint}
          >
            {action.icon ? <Icon name={action.icon} size="sm" decorative /> : null}
            {action.label}
          </LnButton>
        ))}
      </div>
      {derived.groups.map((group) => (
        <section className="fp-group" key={group.id}>
          {group.heading ? <h3>{group.heading}</h3> : null}
          {group.actions.map((action) => (
            <LnButton
              key={action.id}
              variant="ghost"
              className="fp-row"
              data-inert={action.state.kind === "inert" ? "true" : undefined}
              data-tone={action.tone === "danger" ? "danger" : undefined}
              disabled={action.state.kind === "inert"}
            >
              <span>{action.label}</span>
              {action.caption ? <small>{action.caption}</small> : null}
            </LnButton>
          ))}
        </section>
      ))}
    </div>
  );
}

export function OwnerFicha({
  fixture,
  qrSvg,
  width,
}: {
  fixture: FichaFixture;
  qrSvg: string;
  width: "phone" | "desk";
}) {
  const situation = fixture.situation === "al-dia" ? undefined : fixture.situation;
  const actions = fixture.showActions
    ? derivePetActions({
        viewerRole: fixture.viewerRole,
        isTitular: fixture.viewerRole === "owner",
        petStatus: fixture.petStatus,
        species: fixture.meta.startsWith("Gato") ? "cat" : "dog",
        pppDoor: false,
      })
    : null;
  const front = <Front fixture={fixture} qrSvg={qrSvg} />;
  return (
    <div className="fp-frame" data-width={width}>
      <p className="fp-width">{width === "phone" ? "390 px" : "Escritorio"}</p>
      <div className="pc-cred" data-situation={situation} data-ficha={fixture.id}>
        {fixture.flip ? (
          <PublicCarnetTurn
            subtitleFront={CHROME.subtitleFront}
            subtitleBack={CHROME.subtitleBack ?? "Libreta"}
            front={front}
            back={<Back fixture={fixture} />}
          />
        ) : (
          <>
            <PublicDocumentBand subtitle={CHROME.subtitleFront} />
            {front}
          </>
        )}
      </div>
      {actions ? <Actions derived={actions} /> : null}
    </div>
  );
}
