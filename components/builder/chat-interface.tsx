'use client';

import { useState, useRef, useEffect } from 'react';
import { Zap, Send, Loader as Loader2, RefreshCw, ChevronRight, Sparkles, WandSparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { GenerationResult, matchTemplate, customizeTemplate } from '@/lib/generator';
import { AutomationTemplate, PROMPT_EXAMPLES } from '@/lib/templates';
import { supabase } from '@/lib/supabase-client';
import { cn } from '@/lib/utils';

type MessageRole = 'user' | 'assistant';

interface Message {
  id: string;
  role: MessageRole;
  content: string;
  result?: GenerationResult;
  timestamp: Date;
  isCustomization?: boolean;
}

interface ChatInterfaceProps {
  initialTemplate?: AutomationTemplate | null;
  onGenerated: (result: GenerationResult | null, prompt?: string) => void;
  currentResult: GenerationResult | null;
}

function TypingIndicator() {
  return (
    <div className="flex items-center gap-1.5 px-4 py-3">
      <div className="w-7 h-7 rounded-full bg-primary/20 flex items-center justify-center flex-shrink-0">
        <Zap className="w-3.5 h-3.5 text-primary" />
      </div>
      <div className="flex items-center gap-1 px-3 py-2 rounded-xl bg-muted/50">
        {[0, 1, 2].map(i => (
          <span key={i} className="w-1.5 h-1.5 rounded-full bg-muted-foreground animate-bounce"
            style={{ animationDelay: `${i * 150}ms` }} />
        ))}
      </div>
    </div>
  );
}

export function ChatInterface({ initialTemplate, onGenerated, currentResult }: ChatInterfaceProps) {
  const [messages, setMessages] = useState<Message[]>([
    {
      id: 'welcome',
      role: 'assistant',
      content: "Welcome to MagicFlux. Describe the business workflow you want to automate and I'll generate a production-ready n8n package — workflow JSON, environment config, credentials checklist, and setup guide.",
      timestamp: new Date()
    }
  ]);
  const [input, setInput] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const sessionId = useRef(`session-${Date.now()}`);

  useEffect(() => {
    if (initialTemplate && messages.length === 1) {
      setInput(`Build the ${initialTemplate.name} automation`);
    }
  }, [initialTemplate]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isGenerating]);

  const isModification = (text: string) => {
    const triggers = ['add ', 'remove ', 'switch ', 'change ', 'include ', 'replace ', 'use ', 'also '];
    return currentResult !== null && triggers.some(t => text.toLowerCase().startsWith(t) || text.toLowerCase().includes(t));
  };

  async function handleGenerate(overrideInput?: string) {
    const trimmed = (overrideInput ?? input).trim();
    if (!trimmed || isGenerating) return;

    const userMessage: Message = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: trimmed,
      timestamp: new Date(),
      isCustomization: isModification(trimmed)
    };

    setMessages(prev => [...prev, userMessage]);
    setInput('');
    setIsGenerating(true);

    await new Promise(r => setTimeout(r, 900 + Math.random() * 700));

    let result: GenerationResult;
    if (isModification(trimmed) && currentResult) {
      result = await customizeTemplate(trimmed, currentResult);
    } else {
      result = await matchTemplate(trimmed);
    }

    const aiMessage: Message = {
      id: `ai-${Date.now()}`,
      role: 'assistant',
      content: result.responseMessage,
      result,
      timestamp: new Date(),
      isCustomization: isModification(trimmed)
    };

    setMessages(prev => [...prev, aiMessage]);
    setIsGenerating(false);
    onGenerated(result, trimmed);

    supabase.from('automation_generations').insert({
      prompt: trimmed,
      template_id: result.template.id,
      template_name: result.template.name,
      industry: result.template.industry,
      session_id: sessionId.current
    }).then(() => {}, () => {});
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleGenerate();
    }
  }

  function handleReset() {
    setMessages([messages[0]]);
    onGenerated(null, undefined);
  }

  function formatMessage(content: string) {
    return content.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
  }

  const lastResult = messages.filter(m => m.result).at(-1)?.result;
  const suggestions = lastResult?.customizationSuggestions || [];

  return (
    <div className="flex flex-col h-full rounded-xl border border-border bg-card overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 border-b border-border bg-muted/20 flex items-center gap-3 flex-shrink-0">
        <div className="w-8 h-8 rounded-lg bg-primary/20 flex items-center justify-center">
          <Zap className="w-4 h-4 text-primary" />
        </div>
        <div>
          <h3 className="text-sm font-semibold">AutoBuilder AI</h3>
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
            {isGenerating ? 'Generating...' : 'Ready'}
          </div>
        </div>
        {messages.length > 1 && (
          <button onClick={handleReset}
            className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground px-2 py-1 rounded-md hover:bg-muted/50 transition-colors">
            <RefreshCw className="w-3 h-3" />
            New session
          </button>
        )}
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto scrollbar-thin py-3 space-y-1">
        {messages.map(message => (
          <div key={message.id}>
            {message.role === 'user' ? (
              <div className="flex items-start gap-3 px-4 py-1.5 flex-row-reverse">
                <div className="w-7 h-7 rounded-full bg-secondary border border-border flex items-center justify-center flex-shrink-0 text-xs font-semibold">
                  U
                </div>
                <div className={cn(
                  'max-w-[80%] rounded-2xl rounded-tr-sm px-4 py-2.5 text-sm leading-relaxed',
                  message.isCustomization
                    ? 'bg-primary/20 text-primary border border-primary/30'
                    : 'bg-primary text-primary-foreground'
                )}>
                  {message.isCustomization && (
                    <span className="flex items-center gap-1 text-xs mb-1 opacity-70">
                      <WandSparkles className="w-3 h-3" /> Customization
                    </span>
                  )}
                  {message.content}
                </div>
              </div>
            ) : (
              <div className="flex items-start gap-3 px-4 py-1.5">
                <div className="w-7 h-7 rounded-full bg-primary/20 flex items-center justify-center flex-shrink-0">
                  <Zap className="w-3.5 h-3.5 text-primary" />
                </div>
                <div className="flex-1 max-w-[85%]">
                  <div
                    className="rounded-2xl rounded-tl-sm px-4 py-2.5 bg-muted/50 text-sm leading-relaxed text-foreground"
                    dangerouslySetInnerHTML={{ __html: formatMessage(message.content) }}
                  />
                  {message.result && (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      <span className="text-xs px-2 py-1 rounded-md bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                        ✓ {message.result.template.nodeCount} nodes
                      </span>
                      <span className="text-xs px-2 py-1 rounded-md bg-primary/10 text-primary border border-primary/20">
                        {Math.round(message.result.confidence)}% match
                      </span>
                      {message.result.packageScore && (
                        <span className="text-xs px-2 py-1 rounded-md bg-amber-500/10 text-amber-400 border border-amber-500/20">
                          Score {message.result.packageScore.automationScore}/10
                        </span>
                      )}
                      {message.result.appliedCustomizations && message.result.appliedCustomizations.length > 0 && (
                        <span className="text-xs px-2 py-1 rounded-md bg-purple-500/10 text-purple-400 border border-purple-500/20">
                          {message.result.appliedCustomizations.length} customization{message.result.appliedCustomizations.length > 1 ? 's' : ''} applied
                        </span>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        ))}

        {isGenerating && <TypingIndicator />}

        {/* Customization suggestions - show after last AI response */}
        {!isGenerating && suggestions.length > 0 && messages.at(-1)?.role === 'assistant' && (
          <div className="px-4 py-2">
            <p className="text-xs text-muted-foreground mb-2 flex items-center gap-1.5">
              <Sparkles className="w-3 h-3 text-primary" />
              Customize this automation:
            </p>
            <div className="flex flex-wrap gap-1.5">
              {suggestions.map((s, i) => (
                <button
                  key={i}
                  onClick={() => handleGenerate(s)}
                  className="text-xs px-2.5 py-1.5 rounded-lg border border-primary/20 hover:border-primary/50 bg-primary/5 hover:bg-primary/10 text-primary transition-all flex items-center gap-1"
                >
                  <WandSparkles className="w-3 h-3" />
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Prompt examples - only at start */}
        {messages.length === 1 && !isGenerating && (
          <div className="px-4 py-2">
            <p className="text-xs text-muted-foreground mb-2">Try an example:</p>
            <div className="flex flex-wrap gap-1.5">
              {PROMPT_EXAMPLES.slice(0, 4).map(example => (
                <button key={example} onClick={() => handleGenerate(example)}
                  className="text-xs px-2.5 py-1.5 rounded-lg border border-border hover:border-primary/40 hover:bg-primary/5 text-muted-foreground hover:text-foreground transition-all flex items-center gap-1">
                  <ChevronRight className="w-3 h-3" />
                  {example}
                </button>
              ))}
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="p-3 border-t border-border bg-muted/10 flex-shrink-0">
        <div className="flex gap-2 items-end">
          <Textarea
            ref={textareaRef}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={currentResult
              ? 'Customize: "Add Slack notification", "Add approval step"...'
              : 'Describe the automation you want to build...'}
            className="resize-none text-sm min-h-[42px] max-h-[120px] bg-background border-border focus:border-primary scrollbar-thin"
            rows={1}
            disabled={isGenerating}
          />
          <Button
            onClick={() => handleGenerate()}
            disabled={!input.trim() || isGenerating}
            size="icon"
            className="h-10 w-10 flex-shrink-0 shadow-md shadow-primary/20"
          >
            {isGenerating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground mt-1.5 px-1">
          {currentResult ? 'Type to customize · ' : ''}Enter to generate · Shift+Enter for new line
        </p>
      </div>
    </div>
  );
}
