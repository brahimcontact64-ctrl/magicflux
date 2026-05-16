'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { ArrowRight, Sparkles, Zap, Play } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { PROMPT_EXAMPLES } from '@/lib/templates';
import { cn } from '@/lib/utils';

const ROTATING_WORDS = ['Property Managers', 'Airbnb Hosts', 'Shopify Stores', 'Business Owners'];

export function Hero() {
  const [wordIndex, setWordIndex] = useState(0);
  const [typedExample, setTypedExample] = useState('');
  const [exampleIndex, setExampleIndex] = useState(0);
  const [isTyping, setIsTyping] = useState(true);

  useEffect(() => {
    const interval = setInterval(() => {
      setWordIndex(i => (i + 1) % ROTATING_WORDS.length);
    }, 2500);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const example = PROMPT_EXAMPLES[exampleIndex];
    let i = 0;
    setTypedExample('');
    setIsTyping(true);

    const typeInterval = setInterval(() => {
      if (i < example.length) {
        setTypedExample(example.slice(0, i + 1));
        i++;
      } else {
        clearInterval(typeInterval);
        setIsTyping(false);
        setTimeout(() => {
          setExampleIndex(idx => (idx + 1) % PROMPT_EXAMPLES.length);
        }, 2000);
      }
    }, 40);

    return () => clearInterval(typeInterval);
  }, [exampleIndex]);

  return (
    <section className="relative min-h-screen flex items-center justify-center overflow-hidden pt-16">
      {/* Background */}
      <div className="absolute inset-0 grid-pattern opacity-40" />
      <div className="absolute inset-0 bg-gradient-to-b from-transparent via-transparent to-background" />
      <div className="absolute top-1/3 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] rounded-full bg-primary/5 blur-[120px] pointer-events-none" />
      <div className="absolute top-1/2 left-1/4 w-[300px] h-[300px] rounded-full bg-blue-500/5 blur-[100px] pointer-events-none" />

      <div className="relative z-10 max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
        {/* Badge */}
        <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full border border-primary/30 bg-primary/10 text-primary text-xs font-medium mb-8 animate-in-up">
          <Sparkles className="w-3 h-3" />
          <span>MagicFlux</span>
          <span className="w-1 h-1 rounded-full bg-primary" />
          <span>No coding required</span>
        </div>

        {/* Headline */}
        <h1 className="text-4xl sm:text-5xl lg:text-7xl font-bold tracking-tight leading-[1.1] mb-6">
          Turn prompts into{' '}
          <span className="text-gradient">live automations</span>
        </h1>

        {/* Subheading */}
        <p className="text-lg sm:text-xl text-muted-foreground max-w-2xl mx-auto mb-4 leading-relaxed">
          MagicFlux converts plain English into fully deployed workflows powered by n8n.
        </p>

        {/* Rotating target audience */}
        <p className="text-sm text-muted-foreground mb-10">
          Built for{' '}
          <span className="text-primary font-medium transition-all duration-300">
            {ROTATING_WORDS[wordIndex]}
          </span>
        </p>

        {/* Interactive Prompt Preview */}
        <div className="max-w-2xl mx-auto mb-10">
          <div className="relative rounded-2xl border border-border bg-card/80 backdrop-blur-sm shadow-2xl shadow-black/20 overflow-hidden">
            <div className="flex items-center gap-2 px-4 py-3 border-b border-border bg-muted/30">
              <div className="w-3 h-3 rounded-full bg-red-500/70" />
              <div className="w-3 h-3 rounded-full bg-yellow-500/70" />
              <div className="w-3 h-3 rounded-full bg-green-500/70" />
              <span className="ml-2 text-xs text-muted-foreground font-mono">MagicFlux</span>
            </div>
            <div className="p-4 flex items-center gap-3">
              <div className="w-7 h-7 rounded-full bg-primary/20 flex items-center justify-center flex-shrink-0">
                <Zap className="w-3.5 h-3.5 text-primary" />
              </div>
              <div className="flex-1 text-left">
                <p className="text-sm text-foreground font-mono leading-relaxed">
                  {typedExample}
                  {isTyping && (
                    <span className="inline-block w-0.5 h-4 bg-primary ml-0.5 animate-cursor align-middle" />
                  )}
                </p>
              </div>
            </div>
            <div className="flex items-center justify-between px-4 py-3 border-t border-border bg-muted/20">
              <span className="text-xs text-muted-foreground">Press Enter to generate</span>
              <div className="flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
                <span className="text-xs text-muted-foreground">Planner available</span>
              </div>
            </div>
          </div>
        </div>

        {/* CTAs */}
        <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
          <Link href="/builder">
            <Button size="lg" className="gap-2 font-medium px-8 h-12 text-base shadow-lg shadow-primary/20 hover:shadow-primary/30 transition-shadow animate-pulse-glow">
              <Zap className="w-4 h-4" fill="currentColor" />
              Build Your First Automation
              <ArrowRight className="w-4 h-4" />
            </Button>
          </Link>
          <a href="#demo">
            <Button size="lg" variant="ghost" className="gap-2 font-medium h-12 text-base">
              <Play className="w-4 h-4" />
              See a Demo
            </Button>
          </a>
        </div>

        {/* Social proof */}
        <p className="mt-8 text-xs text-muted-foreground">
          Free to generate &middot; No account required &middot; n8n-compatible JSON
        </p>

        {/* Stats */}
        <div className="mt-16 grid grid-cols-3 gap-8 max-w-md mx-auto">
          {[
            { value: '9+', label: 'Templates' },
            { value: '3', label: 'Industries' },
            { value: '<30s', label: 'Generation Time' }
          ].map(stat => (
            <div key={stat.label} className="text-center">
              <p className="text-2xl font-bold text-gradient">{stat.value}</p>
              <p className="text-xs text-muted-foreground mt-1">{stat.label}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
