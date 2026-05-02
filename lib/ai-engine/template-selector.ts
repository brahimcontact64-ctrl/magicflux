import { ParsedIntent } from './types';
import { AUTOMATION_TEMPLATES, AutomationTemplate } from '../templates';

export function selectTemplate(
  intent: ParsedIntent,
  previousTemplateId?: string
): { template: AutomationTemplate; matchScore: number } {
  if (intent.isModification && previousTemplateId) {
    const prev = AUTOMATION_TEMPLATES.find(t => t.id === previousTemplateId);
    if (prev) return { template: prev, matchScore: 95 };
  }

  const scored = AUTOMATION_TEMPLATES.map(template => ({
    template,
    score: scoreTemplate(intent, template)
  }));

  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];

  const matchScore = Math.min(97, Math.max(65, best.score * 7 + 45));
  return { template: best.template, matchScore };
}

function scoreTemplate(intent: ParsedIntent, template: AutomationTemplate): number {
  let score = 0;
  const prompt = intent.rawPrompt.toLowerCase();

  for (const keyword of template.keywords) {
    if (prompt.includes(keyword.toLowerCase())) {
      score += keyword.includes(' ') ? 4 : 2;
    }
  }

  if (intent.industry === template.industry) score += 15;

  for (const integration of intent.integrationsRequested) {
    if (template.tags.includes(integration)) score += 3;
  }

  for (const trigger of intent.triggersRequested) {
    if (template.tags.includes(trigger)) score += 3;
  }

  const industryKeywords: Record<string, string[]> = {
    'property-management': ['property', 'tenant', 'landlord', 'apartment', 'unit', 'rent', 'lease', 'maintenance'],
    'airbnb': ['airbnb', 'guest', 'host', 'rental', 'listing', 'booking', 'turnover', 'check-in', 'check-out'],
    'shopify': ['shopify', 'store', 'order', 'cart', 'customer', 'product', 'fulfillment', 'return']
  };

  const industryKws = industryKeywords[template.industry] || [];
  for (const kw of industryKws) {
    if (prompt.includes(kw)) score += 2;
  }

  return score;
}
