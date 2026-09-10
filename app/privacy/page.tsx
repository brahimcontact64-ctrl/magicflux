import type { Metadata } from 'next';
import { Navbar } from '@/components/landing/navbar';
import { Footer } from '@/components/landing/footer';

export const metadata: Metadata = {
  title: 'Privacy Policy — MagicFlux',
  description: 'How MagicFlux collects, uses, and protects information during the Free Beta.',
};

const LAST_UPDATED = 'September 10, 2026';

/**
 * Phase 9.7 — Free Beta Privacy Policy.
 *
 * Every factual claim on this page was checked against the current
 * production implementation before being written (not carried over from
 * an earlier report's claims) -- see the Phase 9.7 audit notes for the
 * exact code paths each paragraph below is grounded in:
 *
 *   - AI generation: lib/ai-engine/pro-planner.ts (generateOpenAIPlan) and
 *     lib/agent/executor.ts / lib/agent/loop.ts (the /builder chat agent),
 *     both call OpenAI's API directly with your prompt text and a
 *     structured summary of intent -- confirmed by reading the exact
 *     fetch()/messages payloads, not assumed.
 *   - Credential handling: the recommended path (Settings > Integrations,
 *     app/api/credentials/connect/route.ts) encrypts values with
 *     AES-256-GCM (lib/security/encryption.ts) and never includes them in
 *     an OpenAI request. Separately, lib/agent/tools.ts registers a
 *     validate_credential function tool the AI chat agent can call when
 *     you paste an API key directly into the chat -- confirmed this means
 *     that text does reach OpenAI in that specific path, so this page
 *     says so honestly instead of claiming credentials are "never" sent
 *     to any AI provider.
 *   - Execution logs: supabase/migrations/20260509091500_execution_v2_tables.sql
 *     (workflow_executions_v2) stores input_data/output_data jsonb columns
 *     -- confirmed this can include data that passed through connected
 *     integrations.
 *   - Webhook IP logging: lib/runtime/webhook-security.ts and
 *     runtime_webhook_request_log (ip_address column) -- confirmed this
 *     logs the source IP of incoming requests to a workflow's webhook
 *     trigger, not the MagicFlux user's own browsing IP.
 *   - Redaction: lib/security/redact.ts is a real, broadly-applied
 *     deep-object secret redactor (confirmed by reading the file, not
 *     inferred from its name).
 *   - Cookies: lib/auth-context.tsx sets exactly one first-party cookie,
 *     mf_access_token; Supabase's client SDK keeps a session token in
 *     browser localStorage. No third-party analytics/tracking script
 *     exists anywhere in app/ or components/ (checked directly).
 *   - Stripe/billing: app/api/stripe/checkout/route.ts returns 503 today
 *     because STRIPE_SECRET_KEY is not configured -- confirmed live
 *     against production, not assumed from an earlier phase.
 *   - Beta analytics: lib/analytics/beta-metrics.ts's own doc comment,
 *     confirmed by reading every query in the file, states every metric
 *     is a COUNT/aggregate -- no per-user content is exposed by it.
 *
 * No LLC/company entity, registration number, registered address, VAT/tax
 * ID, certification, or GDPR/SOC2/ISO compliance claim appears anywhere
 * on this page -- none of those are true today, and inventing any of them
 * would itself be a misrepresentation. See the "Who operates MagicFlux"
 * and "Governing law" sections for what is deliberately left unstated
 * pending professional legal review.
 */
export default function PrivacyPolicyPage() {
  return (
    <div className="min-h-screen bg-background">
      <Navbar />
      <main className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-12 sm:py-16">
        <h1 className="text-3xl sm:text-4xl font-bold tracking-tight mb-2">Privacy Policy</h1>
        <p className="text-sm text-muted-foreground mb-10">Last updated: {LAST_UPDATED} · Applies to the MagicFlux Free Beta</p>

        <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-4 mb-10 text-sm leading-relaxed">
          <strong className="text-amber-500">MagicFlux is in Free Beta.</strong>{' '}
          This policy describes what we actually do today, not a finished, general-availability product. It will change as the
          product changes — see &ldquo;Changes to this policy&rdquo; below.
        </div>

        <section className="space-y-8 text-sm sm:text-base leading-relaxed text-foreground/90">
          <div>
            <h2 className="text-xl font-semibold mb-3">Who operates MagicFlux</h2>
            <p>
              MagicFlux is currently built and operated directly by its founders, Brahim Beldjilali and Mohamed Nassim, from
              Algeria. MagicFlux is not currently organized as a separate registered company, and this policy does not state a
              company registration number, registered office, or VAT/tax identifier, because none exists yet. This will be
              addressed before any paid or general-availability launch — see &ldquo;A note on legal review&rdquo; at the end of
              this page.
            </p>
          </div>

          <div>
            <h2 className="text-xl font-semibold mb-3">What we collect</h2>
            <ul className="list-disc pl-5 space-y-2">
              <li>
                <strong>Account information.</strong> Your email address and authentication credentials are managed by our
                authentication provider, Supabase — we never see or store your plaintext password.
              </li>
              <li>
                <strong>Automation prompts and descriptions.</strong> The text you write describing the automation you want,
                whether in the guided builder or the AI chat.
              </li>
              <li>
                <strong>Workflow configuration.</strong> The workflows you build — their name, description, node structure, and
                which integrations they use.
              </li>
              <li>
                <strong>Execution data and logs.</strong> When a workflow runs (as a test or live), we store its status,
                timestamps, retry count, error messages, and the input/output data for that run. Because this reflects what
                your automation actually did, it can include data that passed through a connected third-party service (for
                example, the contents of a Shopify order or a Slack message your workflow processed).
              </li>
              <li>
                <strong>Integration credentials.</strong> API keys or tokens you connect via Settings → Integrations are
                encrypted at rest (AES-256-GCM) before storage and are used only to run your own workflows.
              </li>
              <li>
                <strong>Feedback.</strong> If you submit feedback, we store its category, optional 1–5 rating, optional
                comment, the page you were on, and the app version — tied to your account.
              </li>
              <li>
                <strong>Aggregate Beta usage metrics.</strong> Our founders can see Beta-wide counts (signups, workflows
                created, executions, feedback volume/average rating) to understand how the Beta is going. These are counts
                only — this dashboard does not expose your individual prompts, workflow contents, or credentials.
              </li>
              <li>
                <strong>Session cookie and browser storage.</strong> One first-party cookie (<code>mf_access_token</code>) keeps
                you signed in; our authentication library also keeps a session token in your browser&apos;s local storage. A
                couple of interface preferences (like your last-used builder mode) are stored locally in your browser and are
                never sent to us. We do not use third-party analytics, advertising, or tracking scripts on MagicFlux today.
              </li>
              <li>
                <strong>Webhook request logs.</strong> If a workflow you build has a webhook trigger, we log the source IP
                address of requests made <em>to that webhook</em> (not your own browsing activity) to detect abuse and enforce
                any IP allowlist you configure.
              </li>
              <li>
                <strong>Security event logs.</strong> We log security-relevant events (for example, a suspected prompt
                injection attempt or repeated rate-limit violations) tied to your account, to protect the platform from abuse.
              </li>
            </ul>
          </div>

          <div>
            <h2 className="text-xl font-semibold mb-3">How AI generation works</h2>
            <p className="mb-2">
              When you describe an automation, MagicFlux sends your prompt text — along with a structured summary of the
              detected intent and, for the conversational builder, the current workflow structure — to OpenAI (currently
              GPT-4o family models) to generate or refine the workflow plan. This is necessary for the AI generation feature
              to work at all. OpenAI processes this under its own terms and privacy policy as our AI infrastructure provider.
            </p>
            <p>
              <strong>Please don&apos;t paste real API keys, passwords, or other secrets directly into the AI chat.</strong> If
              you do, that text is sent to OpenAI as part of the conversation, because the assistant can ask to validate a
              credential you&apos;ve typed there. Connecting an integration through Settings → Integrations instead keeps the
              value encrypted and out of any AI prompt entirely — that is the path we recommend.
            </p>
          </div>

          <div>
            <h2 className="text-xl font-semibold mb-3">How workflows and executions are stored</h2>
            <p>
              Workflows and their execution history are stored in our Postgres database (hosted by Supabase), scoped to your
              account. Access to this data is enforced both at the database level (row-level security) and in every API route
              that reads or writes it (explicit ownership checks) — including for our own founders, whose administrative
              access does not extend to reading other users&apos; private workflow or execution data.
            </p>
          </div>

          <div>
            <h2 className="text-xl font-semibold mb-3">Integrations and credentials</h2>
            <p>
              Credentials for third-party integrations (for example Shopify, Slack, Airtable, Gmail, or Google Drive) are
              encrypted at rest and used exclusively to run automations you configure, on your behalf. We do not use your
              connected credentials for any purpose other than running the workflow you built, and we do not share them
              between accounts.
            </p>
          </div>

          <div>
            <h2 className="text-xl font-semibold mb-3">Feedback and Beta metrics</h2>
            <p>
              Feedback you submit is visible to our founders so we can act on it, and its rating (if any) feeds into an
              aggregate average shown on an internal Beta dashboard. It is not shared outside MagicFlux and is not linked to
              any public profile.
            </p>
          </div>

          <div>
            <h2 className="text-xl font-semibold mb-3">Third-party service providers we use</h2>
            <ul className="list-disc pl-5 space-y-2">
              <li><strong>Supabase</strong> — database, authentication, and file storage infrastructure.</li>
              <li><strong>OpenAI</strong> — AI generation, as described above.</li>
              <li><strong>Vercel</strong> — application hosting.</li>
              <li>
                <strong>Whichever integrations you connect yourself</strong> (Shopify, Slack, Airtable, Gmail, Google Drive, or
                a custom API) — your automation exchanges data directly with those services according to how you configure it.
              </li>
              <li>
                <strong>Stripe</strong> is integrated in our codebase for potential future billing but is <strong>not active
                today</strong> — no payment information is collected or processed, because paid plans are not currently
                purchasable.
              </li>
            </ul>
          </div>

          <div>
            <h2 className="text-xl font-semibold mb-3">Security practices we actually have in place</h2>
            <ul className="list-disc pl-5 space-y-2">
              <li>Integration credentials are encrypted at rest with AES-256-GCM.</li>
              <li>An automated redaction layer strips secret-looking fields (API keys, tokens, passwords, authorization headers) from logs and error records before they are stored or displayed.</li>
              <li>Row-level security and explicit per-account ownership checks isolate your data from other accounts, including administrative accounts.</li>
              <li>Rate limiting on feedback submission and on AI/automation actions to reduce abuse.</li>
              <li>Custom code execution (a &ldquo;Code&rdquo;/&ldquo;Function&rdquo; node) is not offered — it is blocked at every layer, not merely hidden in the interface.</li>
            </ul>
            <p className="mt-2">
              We do not claim certifications (such as SOC 2 or ISO 27001) or formal regulatory compliance (such as GDPR) at
              this stage — none has been obtained or independently verified, and we won&apos;t claim one until it has been.
            </p>
          </div>

          <div>
            <h2 className="text-xl font-semibold mb-3">Your choices and rights</h2>
            <p className="mb-2">
              You can review, edit, and delete your own workflows directly in the product today. For anything without a
              self-service control yet — including full account deletion, correcting a specific stored record, or requesting
              an export of your data — email <a className="text-primary hover:underline" href="mailto:hello@magicflux.ai">hello@magicflux.ai</a> and
              we will handle it manually. We do not yet have an automatic self-service data export or account-deletion button;
              we&apos;re telling you that plainly rather than implying one exists.
            </p>
          </div>

          <div>
            <h2 className="text-xl font-semibold mb-3">Contact</h2>
            <p>
              Questions about this policy or your data: <a className="text-primary hover:underline" href="mailto:hello@magicflux.ai">hello@magicflux.ai</a>.
            </p>
          </div>

          <div>
            <h2 className="text-xl font-semibold mb-3">Changes to this policy</h2>
            <p>
              We&apos;ll update the &ldquo;Last updated&rdquo; date at the top of this page whenever this policy changes. If we
              make a material change, we&apos;ll make a reasonable effort to bring it to your attention (for example, a notice
              on the site) before it takes effect — we don&apos;t currently have a guaranteed email-notification mechanism for
              policy changes, so we won&apos;t promise one.
            </p>
          </div>

          <div className="border-t border-border pt-6">
            <h2 className="text-xl font-semibold mb-3">A note on legal review</h2>
            <p>
              This policy intentionally does not state a governing law, a jurisdiction for disputes, or a data-retention
              schedule beyond what is described above, because none of those has been finalized or independently verified. We
              recommend professional legal review of this policy before any paid or general-availability launch.
            </p>
          </div>
        </section>
      </main>
      <Footer />
    </div>
  );
}
