import { Navbar } from '@/components/landing/navbar';
import { Hero } from '@/components/landing/hero';
import { HowItWorks } from '@/components/landing/how-it-works';
import { IndustryTemplates } from '@/components/landing/industry-templates';
import { DemoPreview } from '@/components/landing/demo-preview';
import { ManagedCatalog } from '@/components/landing/managed-catalog';
import { Pricing } from '@/components/landing/pricing';
import { Waitlist } from '@/components/landing/waitlist';
import { Footer } from '@/components/landing/footer';

export default function LandingPage() {
  return (
    <div className="min-h-screen">
      <Navbar />
      <main>
        <Hero />
        <HowItWorks />
        <IndustryTemplates />
        <DemoPreview />
        <ManagedCatalog />
        <Pricing />
        <Waitlist />
      </main>
      <Footer />
    </div>
  );
}
