'use client';

import Link from 'next/link';
import { ArrowRight, Zap, CircleCheck as CheckCircle2, FileCode2, FileText, BookOpen, Download } from 'lucide-react';
import { Button } from '@/components/ui/button';

const DEMO_CONVERSATION = [
  {
    role: 'user',
    content: 'Build an Airbnb guest messaging automation that sends welcome and pre-arrival instructions'
  },
  {
    role: 'ai',
    content: "I've matched your request to the **Guest Messaging Automation** template. I've generated a complete n8n-compatible workflow package with 5 nodes including a booking webhook, automated welcome email, and timed pre-arrival instructions."
  }
];

const OUTPUT_TABS = [
  { id: 'json', icon: FileCode2, label: 'workflow.json', color: 'text-blue-400' },
  { id: 'env', icon: FileText, label: '.env.example', color: 'text-emerald-400' },
  { id: 'guide', icon: BookOpen, label: 'README-setup.md', color: 'text-amber-400' },
  { id: 'download', icon: Download, label: 'Download ZIP', color: 'text-cyan-400' }
];

const JSON_PREVIEW = `{
  "name": "Airbnb Guest Messaging",
  "nodes": [
    {
      "name": "Booking Webhook",
      "type": "n8n-nodes-base.webhook",
      "position": [250, 300]
    },
    {
      "name": "Parse Booking",
      "type": "n8n-nodes-base.code",
      "position": [450, 300]
    },
    {
      "name": "Send Welcome Email",
      "type": "n8n-nodes-base.emailSend",
      "position": [650, 200]
    }
  ],
  "active": false,
  "id": "guest-messaging-v1"
}`;

export function DemoPreview() {
  return (
    <section id="demo" className="py-24 relative overflow-hidden">
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[400px] rounded-full bg-primary/5 blur-[150px] pointer-events-none" />

      <div className="relative z-10 max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        {/* Header */}
        <div className="text-center mb-16">
          <p className="text-xs font-medium text-primary uppercase tracking-widest mb-3">Live Demo</p>
          <h2 className="text-3xl sm:text-4xl font-bold tracking-tight mb-4">
            See it in{' '}
            <span className="text-gradient">action</span>
          </h2>
          <p className="text-muted-foreground max-w-xl mx-auto">
            Watch how a natural language prompt transforms into a complete automation package.
          </p>
        </div>

        {/* Demo UI */}
        <div className="grid lg:grid-cols-5 gap-0 rounded-2xl border border-border overflow-hidden shadow-2xl shadow-black/30 bg-card max-w-5xl mx-auto">
          {/* Chat Panel */}
          {/* Phase 9.5 Step N: min-w-0 -- grid items default to min-width:auto,
              so without it this column refused to shrink below its message
              bubbles' natural content width, pushing the whole page wider
              than the viewport on every mobile/tablet breakpoint (and on
              desktop Safari). Purely a shrink-floor fix; no effect on the
              lg: column width itself. */}
          <div className="lg:col-span-2 border-r border-border flex flex-col min-w-0">
            {/* Header */}
            <div className="px-4 py-3 border-b border-border flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-green-500" />
              <span className="text-xs font-medium text-muted-foreground">AutoBuilder AI</span>
            </div>

            {/* Messages */}
            <div className="flex-1 p-4 space-y-4 min-h-[280px]">
              {DEMO_CONVERSATION.map((msg, i) => (
                <div key={i} className={`flex gap-3 ${msg.role === 'user' ? 'flex-row-reverse' : ''}`}>
                  <div className={`w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 ${
                    msg.role === 'ai'
                      ? 'bg-primary/20 text-primary'
                      : 'bg-secondary text-foreground'
                  }`}>
                    {msg.role === 'ai' ? <Zap className="w-3.5 h-3.5" /> : <span className="text-xs font-bold">U</span>}
                  </div>
                  <div className={`rounded-xl px-3 py-2.5 text-xs leading-relaxed max-w-[85%] ${
                    msg.role === 'ai'
                      ? 'bg-muted/50 text-foreground'
                      : 'bg-primary text-primary-foreground'
                  }`}>
                    {msg.content}
                  </div>
                </div>
              ))}

              {/* Generation Status */}
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <CheckCircle2 className="w-3.5 h-3.5 text-green-500" />
                <span>Package generated successfully</span>
              </div>
            </div>

            {/* Input */}
            <div className="p-3 border-t border-border">
              <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2">
                <span className="text-xs text-muted-foreground flex-1">Try your own prompt...</span>
                <Link href="/builder">
                  <Button size="sm" className="h-6 text-xs gap-1 px-2">
                    Try it <ArrowRight className="w-3 h-3" />
                  </Button>
                </Link>
              </div>
            </div>
          </div>

          {/* Output Panel */}
          <div className="lg:col-span-3 flex flex-col min-w-0">
            {/* Tabs */}
            <div className="flex border-b border-border overflow-x-auto">
              {OUTPUT_TABS.map((tab, i) => (
                <div
                  key={tab.id}
                  className={`flex items-center gap-1.5 px-4 py-3 text-xs whitespace-nowrap border-r border-border cursor-default ${
                    i === 0 ? 'bg-muted/30 border-b-2 border-b-primary text-foreground' : 'text-muted-foreground hover:bg-muted/20'
                  }`}
                >
                  <tab.icon className={`w-3.5 h-3.5 ${tab.color}`} />
                  {tab.label}
                </div>
              ))}
            </div>

            {/* Content */}
            <div className="flex-1 overflow-auto p-4 min-h-[280px]">
              <pre className="text-xs font-mono text-muted-foreground leading-relaxed scrollbar-thin">
                <code>{JSON_PREVIEW}</code>
              </pre>
            </div>

            {/* Footer */}
            <div className="px-4 py-3 border-t border-border flex items-center justify-between bg-muted/20">
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">5 nodes</span>
                <span className="text-border">·</span>
                <span className="text-xs text-muted-foreground">Intermediate</span>
                <span className="text-border">·</span>
                <span className="text-xs text-muted-foreground">~20 min setup</span>
              </div>
              <Link href="/builder">
                <Button size="sm" variant="outline" className="h-7 text-xs gap-1.5">
                  <Download className="w-3 h-3" />
                  Download
                </Button>
              </Link>
            </div>
          </div>
        </div>

        {/* CTA */}
        <div className="text-center mt-10">
          <Link href="/builder">
            <Button size="lg" className="gap-2 shadow-lg shadow-primary/20">
              <Zap className="w-4 h-4" />
              Build Your Automation Now
              <ArrowRight className="w-4 h-4" />
            </Button>
          </Link>
        </div>
      </div>
    </section>
  );
}
