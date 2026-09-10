import type { Metadata } from 'next';
import { Navbar } from '@/components/landing/navbar';
import { Footer } from '@/components/landing/footer';

export const metadata: Metadata = {
  title: 'Terms of Service — MagicFlux',
  description: 'The terms that apply to using the MagicFlux Free Beta.',
};

const LAST_UPDATED = 'September 10, 2026';

/**
 * Phase 9.7 — Free Beta Terms of Service.
 *
 * Deliberately does NOT invent: a company entity, a registration number,
 * a registered office, a governing-law/jurisdiction clause, or a specific
 * monetary liability cap -- none of those has been decided or would be
 * enforceable to state without a real legal decision behind it. Sections
 * that would normally carry one of those are marked "pending legal
 * review" instead of filled with a plausible-sounding placeholder. See
 * the "Legal review" section at the end of this document.
 */
export default function TermsOfServicePage() {
  return (
    <div className="min-h-screen bg-background">
      <Navbar />
      <main className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-12 sm:py-16">
        <h1 className="text-3xl sm:text-4xl font-bold tracking-tight mb-2">Terms of Service</h1>
        <p className="text-sm text-muted-foreground mb-10">Last updated: {LAST_UPDATED} · Applies to the MagicFlux Free Beta</p>

        <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-4 mb-10 text-sm leading-relaxed">
          <strong className="text-amber-500">MagicFlux is a Free Beta product.</strong> It is provided for evaluation and
          feedback, not as a finished, generally available commercial service. Features, limits, and availability can change
          or be discontinued at any time during the Beta.
        </div>

        <section className="space-y-8 text-sm sm:text-base leading-relaxed text-foreground/90">
          <div>
            <h2 className="text-xl font-semibold mb-3">1. Acceptance of these terms</h2>
            <p>
              By creating an account or using MagicFlux, you agree to these Terms. If you don&apos;t agree, don&apos;t use the
              service. MagicFlux is currently built and operated directly by its founders, Brahim Beldjilali and Mohamed
              Nassim, from Algeria — see &ldquo;Legal review&rdquo; below for what that means for enforceability.
            </p>
          </div>

          <div>
            <h2 className="text-xl font-semibold mb-3">2. Free Beta — what that means</h2>
            <p>
              MagicFlux is currently offered free of charge, in Beta. There is no paid subscription available for purchase
              today — any pricing shown in the product describes a future plan, not a current one. Beta features may be
              incomplete, may change without notice, and are not guaranteed to remain available or to be preserved when the
              Beta ends.
            </p>
          </div>

          <div>
            <h2 className="text-xl font-semibold mb-3">3. Your account</h2>
            <p>
              You&apos;re responsible for the accuracy of the information you provide, for keeping your login credentials
              confidential, and for all activity that happens under your account. Tell us at{' '}
              <a className="text-primary hover:underline" href="mailto:hello@magicflux.ai">hello@magicflux.ai</a> if you
              believe your account has been compromised.
            </p>
          </div>

          <div>
            <h2 className="text-xl font-semibold mb-3">4. Acceptable use</h2>
            <p className="mb-2">You agree not to:</p>
            <ul className="list-disc pl-5 space-y-1">
              <li>Use MagicFlux for anything illegal, or to build automations intended to harm, defraud, or harass others.</li>
              <li>Attempt to bypass, disable, or probe the platform&apos;s security, rate limits, or access controls.</li>
              <li>Attempt to access another user&apos;s account, workflows, executions, or feedback.</li>
              <li>Reverse-engineer, scrape, or interfere with the platform&apos;s normal operation.</li>
              <li>Use the AI generation features in a way that violates OpenAI&apos;s own usage policies.</li>
              <li>Submit or process data through the platform that you don&apos;t have the right to use.</li>
            </ul>
          </div>

          <div>
            <h2 className="text-xl font-semibold mb-3">5. You are responsible for your automations</h2>
            <p>
              MagicFlux&apos;s AI can generate automation plans and workflows, but{' '}
              <strong>AI-generated plans may contain errors and must be reviewed by you before you activate them.</strong> Once
              activated, a workflow can take real actions in the third-party services you&apos;ve connected (for example,
              sending a message, creating a record, or modifying data). You are responsible for reviewing, testing, and
              understanding what a workflow will do before activating it, and for any consequence of running it — including in
              connected third-party accounts.
            </p>
          </div>

          <div>
            <h2 className="text-xl font-semibold mb-3">6. Third-party integrations</h2>
            <p>
              Connecting a third-party service (Shopify, Slack, Airtable, Gmail, Google Drive, or a custom API) is subject to
              that provider&apos;s own terms. MagicFlux is not responsible for the availability, accuracy, or behavior of any
              third-party service your automations depend on.
            </p>
          </div>

          <div>
            <h2 className="text-xl font-semibold mb-3">7. Intellectual property</h2>
            <p>
              MagicFlux and its underlying software remain the property of its operators. You retain ownership of the prompts,
              descriptions, and content you provide; by using the service, you grant us the limited right to process that
              content solely to provide the service to you (for example, sending your prompt to our AI provider to generate a
              workflow).
            </p>
          </div>

          <div>
            <h2 className="text-xl font-semibold mb-3">8. Service changes and Beta availability</h2>
            <p>
              Because this is a Beta, we may add, change, or remove features, impose or adjust usage limits, or pause or end
              the Beta at any time. We&apos;ll try to avoid surprises, but we don&apos;t guarantee uninterrupted availability
              during the Beta.
            </p>
          </div>

          <div>
            <h2 className="text-xl font-semibold mb-3">9. Suspension and termination</h2>
            <p>
              We may suspend or terminate your access if we believe, in good faith, that you&apos;ve violated these Terms, pose
              a security risk to the platform or other users, or abused the service. We&apos;ll aim to tell you why where we
              reasonably can.
            </p>
          </div>

          <div>
            <h2 className="text-xl font-semibold mb-3">10. Disclaimers</h2>
            <p>
              MagicFlux is provided <strong>&ldquo;as is&rdquo; and &ldquo;as available,&rdquo;</strong> without warranties of
              any kind, express or implied, including merchantability, fitness for a particular purpose, or non-infringement.
              We don&apos;t warrant that AI-generated content will be accurate, that the service will be uninterrupted or
              error-free, or that any workflow will behave exactly as intended.
            </p>
          </div>

          <div>
            <h2 className="text-xl font-semibold mb-3">11. Limitation of liability</h2>
            <p>
              To the fullest extent permitted by applicable law, MagicFlux and its founders will not be liable for indirect,
              incidental, special, or consequential damages arising from your use of the Beta service, including damages
              resulting from an automation you configured and activated. This section does not state a specific monetary cap,
              a governing law, or a court/jurisdiction for disputes — see &ldquo;Legal review&rdquo; below for why, and what
              that means before you rely on this section.
            </p>
          </div>

          <div>
            <h2 className="text-xl font-semibold mb-3">12. Contact</h2>
            <p>
              Questions about these Terms: <a className="text-primary hover:underline" href="mailto:hello@magicflux.ai">hello@magicflux.ai</a>.
            </p>
          </div>

          <div className="border-t border-border pt-6">
            <h2 className="text-xl font-semibold mb-3">Legal review</h2>
            <p>
              These Terms are written for a Free Beta with no current paid offering, by an unincorporated founder team. They
              deliberately do not state a governing law, a dispute-resolution jurisdiction, a registered company entity, or a
              specific liability cap, because none of those has been decided or would be truthful to assert here. We recommend
              professional legal review of these Terms — including adding governing law, jurisdiction, and a properly
              considered liability framework — before any paid or general-availability launch.
            </p>
          </div>
        </section>
      </main>
      <Footer />
    </div>
  );
}
