'use client';

import { useState } from 'react';
import { FileCode2, FileText, BookOpen, Download, Copy, Check, Clock, Zap, Package, Workflow, Key, SquareCheck as CheckSquare, Variable, Server, Rocket, CircleAlert as AlertCircle, ExternalLink, Sparkles, ChevronRight, Settings } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { GenerationResult } from '@/lib/generator';
import { downloadPackage, downloadFile, generateDownloadFiles } from '@/lib/generator';
import { WorkflowCanvas } from './workflow-canvas';
import { PackageScoreCard } from './package-score';
import { CredentialsWizard } from './credentials-wizard';
import { ManagedRequestModal } from './managed-request-modal';
import { cn } from '@/lib/utils';

type OutputTab = 'canvas' | 'workflow' | 'env' | 'guide' | 'download';

const TABS: { id: OutputTab; icon: React.ElementType; label: string; color: string }[] = [
  { id: 'canvas',   icon: Workflow,   label: 'Canvas',        color: 'text-cyan-400' },
  { id: 'workflow', icon: FileCode2,  label: 'Workflow JSON', color: 'text-blue-400' },
  { id: 'env',      icon: FileText,   label: '.env Config',   color: 'text-emerald-400' },
  { id: 'guide',    icon: BookOpen,   label: 'Setup Guide',   color: 'text-amber-400' },
  { id: 'download', icon: Download,   label: 'Deploy',        color: 'text-primary' }
];

const COMPLEXITY_COLORS: Record<string, string> = {
  beginner:     'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
  intermediate: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
  advanced:     'bg-red-500/10 text-red-400 border-red-500/20'
};

const DEP_TYPE_COLORS: Record<string, string> = {
  account:       'bg-blue-500/10 text-blue-400',
  api_key:       'bg-amber-500/10 text-amber-400',
  tool:          'bg-emerald-500/10 text-emerald-400',
  smtp:          'bg-cyan-500/10 text-cyan-400',
  configuration: 'bg-purple-500/10 text-purple-400'
};

const VAR_TYPE_COLORS: Record<string, string> = {
  email:   'text-cyan-400',
  url:     'text-blue-400',
  api_key: 'text-amber-400',
  number:  'text-emerald-400',
  cron:    'text-purple-400',
  password:'text-red-400',
  string:  'text-muted-foreground'
};

interface OutputPanelProps {
  result: GenerationResult;
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  async function handleCopy() {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }
  return (
    <button
      onClick={handleCopy}
      className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground px-2 py-1 rounded-md hover:bg-muted/50 transition-colors"
    >
      {copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
      {copied ? 'Copied!' : 'Copy'}
    </button>
  );
}

function MarkdownRenderer({ content }: { content: string }) {
  const lines = content.split('\n');
  const elements: React.ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('## ')) {
      elements.push(<h2 key={i} className="text-base font-semibold mt-6 mb-2 first:mt-0 text-foreground">{line.slice(3)}</h2>);
    } else if (line.startsWith('### ')) {
      elements.push(<h3 key={i} className="text-sm font-semibold mt-4 mb-1.5 text-foreground">{line.slice(4)}</h3>);
    } else if (line.startsWith('# ')) {
      elements.push(<h1 key={i} className="text-lg font-bold mb-3 text-foreground">{line.slice(2)}</h1>);
    } else if (line.startsWith('- ')) {
      elements.push(<li key={i} className="text-sm text-muted-foreground ml-4 list-disc leading-relaxed">{line.slice(2)}</li>);
    } else if (line.startsWith('```')) {
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) { codeLines.push(lines[i]); i++; }
      elements.push(
        <pre key={i} className="bg-muted/50 border border-border rounded-lg p-3 my-3 text-xs font-mono overflow-x-auto scrollbar-thin">
          <code>{codeLines.join('\n')}</code>
        </pre>
      );
    } else if (line.trim() === '') {
      elements.push(<div key={i} className="h-2" />);
    } else {
      const html = line
        .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
        .replace(/`(.*?)`/g, '<code class="text-xs bg-muted px-1 py-0.5 rounded font-mono">$1</code>');
      elements.push(<p key={i} className="text-sm text-muted-foreground leading-relaxed" dangerouslySetInnerHTML={{ __html: html }} />);
    }
    i++;
  }
  return <div className="space-y-0.5">{elements}</div>;
}

export function OutputPanel({ result }: OutputPanelProps) {
  const [activeTab, setActiveTab] = useState<OutputTab>('canvas');
  const [showManagedModal, setShowManagedModal] = useState(false);
  const [deployMode, setDeployMode] = useState<'download' | 'managed' | 'credentials'>('download');
  const { template, packageScore, dependencyChecklist, variablesSchema, workflowNodes, workflowEdges, appliedCustomizations } = result;
  const files = generateDownloadFiles(template);
  const workflowJson = JSON.stringify(template.workflow, null, 2);

  const groupedVars = variablesSchema?.reduce<Record<string, typeof variablesSchema>>((acc, v) => {
    if (!acc[v.group]) acc[v.group] = [];
    acc[v.group].push(v);
    return acc;
  }, {}) || {};

  return (
    <div className="flex flex-col h-full rounded-xl border border-border bg-card overflow-hidden">
      {/* Header */}
      <div className="px-4 py-2.5 border-b border-border bg-muted/20 flex items-center justify-between gap-3 flex-shrink-0">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-7 h-7 rounded-lg bg-primary/20 flex items-center justify-center flex-shrink-0">
            <Zap className="w-3.5 h-3.5 text-primary" />
          </div>
          <div className="min-w-0">
            <h3 className="text-xs font-semibold truncate">{template.name}</h3>
            <div className="flex items-center gap-2 mt-0.5">
              <span className={cn('text-[10px] px-1.5 py-0.5 rounded border capitalize', COMPLEXITY_COLORS[template.complexity])}>
                {template.complexity}
              </span>
              <span className="text-[10px] text-muted-foreground flex items-center gap-1">
                <Clock className="w-2.5 h-2.5" />{template.estimatedSetupTime}
              </span>
              <span className="text-[10px] text-muted-foreground">{template.nodeCount} nodes</span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1 text-xs text-muted-foreground flex-shrink-0">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
          <span className="hidden sm:block text-[10px]">{Math.round(result.confidence)}% match</span>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-border overflow-x-auto scrollbar-thin flex-shrink-0">
        {TABS.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={cn(
              'flex items-center gap-1.5 px-3 py-2 text-xs whitespace-nowrap transition-colors border-r border-border flex-shrink-0',
              activeTab === tab.id
                ? 'bg-muted/30 text-foreground border-b-2 border-b-primary'
                : 'text-muted-foreground hover:text-foreground hover:bg-muted/20'
            )}
          >
            <tab.icon className={cn('w-3 h-3', activeTab === tab.id ? tab.color : '')} />
            <span className="hidden sm:block">{tab.label}</span>
          </button>
        ))}
      </div>

      {/* Tab Content */}
      <div className="flex-1 overflow-auto scrollbar-thin">
        {/* CANVAS TAB */}
        {activeTab === 'canvas' && (
          <div className="p-4 space-y-4">
            {packageScore && (
              <PackageScoreCard
                score={packageScore}
                appliedCustomizations={appliedCustomizations}
              />
            )}
            <div>
              <p className="text-xs font-medium mb-3 flex items-center gap-1.5">
                <Workflow className="w-3.5 h-3.5 text-cyan-400" />
                Workflow Preview
              </p>
              <WorkflowCanvas
                nodes={workflowNodes || []}
                edges={workflowEdges || []}
              />
            </div>

            {/* Credentials Needed */}
            {result.credentialsNeeded && result.credentialsNeeded.length > 0 && (
              <div>
                <p className="text-xs font-medium mb-2 flex items-center gap-1.5">
                  <Key className="w-3.5 h-3.5 text-amber-400" />
                  Credentials Required
                </p>
                <div className="space-y-1.5">
                  {result.credentialsNeeded.map((cred, i) => (
                    <div key={i} className="flex items-center gap-2.5 p-2.5 rounded-lg border border-border bg-muted/20">
                      <Key className="w-3.5 h-3.5 text-amber-400 flex-shrink-0" />
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-medium">{cred.service}</p>
                        <p className="text-xs text-muted-foreground">{cred.description}</p>
                      </div>
                      {cred.docsUrl && (
                        <a href={cred.docsUrl} target="_blank" rel="noopener noreferrer"
                          className="text-xs text-primary hover:underline flex items-center gap-0.5 flex-shrink-0">
                          Docs <ExternalLink className="w-3 h-3" />
                        </a>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* WORKFLOW JSON TAB */}
        {activeTab === 'workflow' && (
          <div className="relative h-full min-h-[300px]">
            <div className="absolute top-3 right-3 z-10"><CopyButton text={workflowJson} /></div>
            <pre className="p-4 text-xs font-mono text-muted-foreground leading-relaxed">
              <code>{workflowJson}</code>
            </pre>
          </div>
        )}

        {/* ENV CONFIG TAB */}
        {activeTab === 'env' && (
          <div className="p-4 space-y-4">
            <div className="relative">
              <div className="absolute top-0 right-0"><CopyButton text={files.envConfig} /></div>
              <pre className="bg-muted/30 rounded-lg border border-border p-3 text-xs font-mono text-muted-foreground leading-relaxed overflow-x-auto scrollbar-thin">
                <code>{files.envConfig}</code>
              </pre>
            </div>

            {/* Variables Schema */}
            {Object.entries(groupedVars).length > 0 && (
              <div>
                <p className="text-xs font-medium mb-3 flex items-center gap-1.5">
                  <Variable className="w-3.5 h-3.5 text-emerald-400" />
                  Variables Reference
                </p>
                {Object.entries(groupedVars).map(([group, vars]) => (
                  <div key={group} className="mb-3">
                    <p className="text-xs text-muted-foreground font-medium mb-1.5 uppercase tracking-wide">{group}</p>
                    <div className="space-y-1">
                      {vars.map(v => (
                        <div key={v.key} className="flex items-start gap-2.5 p-2 rounded-md border border-border/50 bg-muted/10">
                          <code className="text-xs font-mono text-foreground flex-shrink-0 pt-0.5">{v.key}</code>
                          <div className="flex-1 min-w-0">
                            <p className="text-xs text-muted-foreground leading-relaxed">{v.description}</p>
                            <code className="text-xs text-muted-foreground/70 font-mono">e.g. {v.example}</code>
                          </div>
                          <div className="flex items-center gap-1 flex-shrink-0">
                            <span className={cn('text-xs font-mono', VAR_TYPE_COLORS[v.type] || 'text-muted-foreground')}>{v.type}</span>
                            {v.required && <span className="text-xs text-red-400">*</span>}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* SETUP GUIDE TAB */}
        {activeTab === 'guide' && (
          <div className="p-4 space-y-4">
            {/* Dependency Checklist */}
            {dependencyChecklist && dependencyChecklist.length > 0 && (
              <div>
                <p className="text-xs font-medium mb-2 flex items-center gap-1.5">
                  <CheckSquare className="w-3.5 h-3.5 text-emerald-400" />
                  Prerequisites Checklist
                </p>
                <div className="space-y-1.5">
                  {dependencyChecklist.map(dep => (
                    <div key={dep.id} className="flex items-center gap-2.5 p-2.5 rounded-lg border border-border bg-card">
                      <div className="w-4 h-4 rounded border border-border flex-shrink-0" />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="text-xs font-medium">{dep.name}</p>
                          <span className={cn('text-xs px-1.5 py-0.5 rounded text-[10px]', DEP_TYPE_COLORS[dep.type] || '')}>
                            {dep.type.replace('_', ' ')}
                          </span>
                          {dep.required && <span className="text-xs text-red-400 text-[10px]">required</span>}
                        </div>
                        <p className="text-xs text-muted-foreground">{dep.description}</p>
                      </div>
                      {dep.setupUrl && (
                        <a href={dep.setupUrl} target="_blank" rel="noopener noreferrer"
                          className="text-xs text-primary hover:underline flex items-center gap-0.5 flex-shrink-0">
                          Setup <ExternalLink className="w-3 h-3" />
                        </a>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
            <MarkdownRenderer content={files.setupGuide} />
          </div>
        )}

        {/* DEPLOY TAB */}
        {activeTab === 'download' && (
          <div className="p-4 space-y-4">
            {/* Mode picker */}
            <div className="grid grid-cols-3 gap-2">
              {[
                { id: 'download' as const, icon: Download, label: 'DIY', sub: 'Download & setup yourself' },
                { id: 'credentials' as const, icon: Settings, label: 'Setup Wizard', sub: 'Step-by-step guide' },
                { id: 'managed' as const, icon: Sparkles, label: 'Done For You', sub: 'We deploy it for you' }
              ].map(m => (
                <button
                  key={m.id}
                  onClick={() => setDeployMode(m.id)}
                  className={cn(
                    'rounded-xl border p-3 flex flex-col items-center gap-1.5 text-center transition-all',
                    deployMode === m.id
                      ? 'border-primary/50 bg-primary/5 text-foreground'
                      : 'border-border bg-card text-muted-foreground hover:border-primary/20 hover:bg-muted/20'
                  )}
                >
                  <m.icon className={cn('w-4 h-4', deployMode === m.id ? 'text-primary' : '')} />
                  <span className="text-xs font-medium">{m.label}</span>
                  <span className="text-[10px] leading-tight hidden sm:block">{m.sub}</span>
                </button>
              ))}
            </div>

            {/* DIY Download mode */}
            {deployMode === 'download' && (
              <div className="space-y-4">
                <Button onClick={() => downloadPackage(template)} className="w-full gap-2 shadow-md shadow-primary/10">
                  <Download className="w-4 h-4" />
                  Download Complete Package
                </Button>
                <p className="text-xs text-muted-foreground text-center">
                  3 files: workflow.json · .env.example · README-setup.md
                </p>

                <div className="space-y-2">
                  {[
                    { icon: FileCode2, label: 'workflow.json', desc: 'n8n workflow definition', color: 'text-blue-400',
                      action: () => downloadFile(workflowJson, 'workflow.json', 'application/json') },
                    { icon: FileText, label: '.env.example', desc: 'Environment variables template', color: 'text-emerald-400',
                      action: () => downloadFile(files.envConfig, '.env.example') },
                    { icon: BookOpen, label: 'README-setup.md', desc: 'Step-by-step setup guide', color: 'text-amber-400',
                      action: () => downloadFile(files.setupGuide, 'README-setup.md', 'text/markdown') }
                  ].map(f => (
                    <button key={f.label} onClick={f.action}
                      className="w-full flex items-center gap-3 p-3 rounded-lg border border-border hover:border-primary/30 hover:bg-muted/30 transition-all group">
                      <f.icon className={cn('w-4 h-4 flex-shrink-0', f.color)} />
                      <div className="flex-1 text-left">
                        <p className="text-xs font-mono font-medium">{f.label}</p>
                        <p className="text-xs text-muted-foreground">{f.desc}</p>
                      </div>
                      <Download className="w-3.5 h-3.5 text-muted-foreground group-hover:text-primary transition-colors" />
                    </button>
                  ))}
                </div>

                {/* n8n direct deploy stub */}
                <div className="rounded-lg border border-border bg-muted/20 p-3">
                  <div className="flex items-center gap-2 mb-1.5">
                    <Rocket className="w-3.5 h-3.5 text-primary" />
                    <p className="text-xs font-medium">Direct n8n Deploy</p>
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-muted border border-border text-muted-foreground">Coming Soon</span>
                  </div>
                  <p className="text-xs text-muted-foreground leading-relaxed mb-2">
                    Add N8N_API_URL and N8N_API_KEY to enable one-click deployment.
                  </p>
                  <Button disabled size="sm" className="w-full gap-2 opacity-60 cursor-not-allowed h-8 text-xs">
                    <Server className="w-3.5 h-3.5" />
                    Deploy to n8n
                  </Button>
                </div>

                <div className="border-t border-border pt-4">
                  <p className="text-xs font-medium mb-3">Next Steps</p>
                  <ol className="space-y-2">
                    {[
                      'Import workflow.json into your n8n instance',
                      'Copy .env.example → .env and fill in credentials',
                      'Follow README-setup.md for configuration',
                      'Activate and run a test execution'
                    ].map((step, i) => (
                      <li key={i} className="flex items-start gap-2.5 text-xs text-muted-foreground">
                        <span className="w-4 h-4 rounded-full bg-primary/15 text-primary text-center leading-4 text-[10px] font-bold flex-shrink-0 mt-0.5">
                          {i + 1}
                        </span>
                        {step}
                      </li>
                    ))}
                  </ol>
                </div>
              </div>
            )}

            {/* Credentials wizard mode */}
            {deployMode === 'credentials' && (
              <CredentialsWizard
                requiredServices={result.credentialsNeeded?.map(c =>
                  c.service.toLowerCase().replace(/\s+/g, '_').replace('google_sheets', 'google_sheets').split('_')[0]
                ).filter((v, i, a) => a.indexOf(v) === i)}
              />
            )}

            {/* Managed / Done For You mode */}
            {deployMode === 'managed' && (
              <div className="space-y-4">
                <div className="rounded-xl border border-primary/20 bg-gradient-to-br from-primary/10 to-primary/5 p-4 space-y-3">
                  <div className="flex items-center gap-2">
                    <Sparkles className="w-4 h-4 text-primary" />
                    <p className="text-sm font-semibold">Done For You Service</p>
                  </div>
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    Our team will set up, configure, and deploy your <strong className="text-foreground">{template.name}</strong> automation in your n8n instance within 48 hours.
                  </p>
                  <ul className="space-y-2">
                    {[
                      'Full n8n setup and configuration',
                      'Credential integration (Gmail, Slack, etc.)',
                      'Testing with your real data',
                      '30-day post-launch support'
                    ].map(item => (
                      <li key={item} className="flex items-center gap-2 text-xs text-muted-foreground">
                        <span className="w-1.5 h-1.5 rounded-full bg-primary flex-shrink-0" />
                        {item}
                      </li>
                    ))}
                  </ul>
                  <Button
                    onClick={() => setShowManagedModal(true)}
                    className="w-full gap-2 shadow-lg shadow-primary/20"
                  >
                    <Sparkles className="w-4 h-4" />
                    Request Managed Setup
                    <ChevronRight className="w-4 h-4" />
                  </Button>
                  <p className="text-xs text-muted-foreground text-center">
                    Starting at $97 · No n8n knowledge needed
                  </p>
                </div>

                {/* Also download option */}
                <button
                  onClick={() => downloadPackage(template)}
                  className="w-full flex items-center gap-3 p-3 rounded-lg border border-border hover:border-primary/20 transition-all group text-left"
                >
                  <Download className="w-4 h-4 text-muted-foreground group-hover:text-primary transition-colors" />
                  <div>
                    <p className="text-xs font-medium">Download package too</p>
                    <p className="text-xs text-muted-foreground">Keep a local copy while we set up</p>
                  </div>
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {showManagedModal && (
        <ManagedRequestModal
          templateId={template.id}
          templateName={template.name}
          onClose={() => setShowManagedModal(false)}
        />
      )}
    </div>
  );
}
