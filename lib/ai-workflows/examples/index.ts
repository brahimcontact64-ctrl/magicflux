import ex01 from './01-webhook-to-slack.json';
import ex02 from './02-webhook-to-email.json';
import ex03 from './03-webhook-to-airtable.json';
import ex04 from './04-shopify-order-to-slack.json';
import ex05 from './05-shopify-order-to-email.json';
import ex06 from './06-shopify-order-to-airtable.json';
import ex07 from './07-shopify-slack-airtable.json';
import ex08 from './08-condition-vip-customer.json';
import ex09 from './09-condition-order-value.json';
import ex10 from './10-wait-then-email.json';
import ex11 from './11-wait-then-slack.json';
import ex12 from './12-shopify-wait-slack.json';
import ex13 from './13-multi-notification.json';
import ex14 from './14-fanout-workflow.json';
import type { WorkflowJson } from '../ai-workflow-spec';

export const EXAMPLE_WORKFLOWS: WorkflowJson[] = [
  ex01 as WorkflowJson,
  ex02 as WorkflowJson,
  ex03 as WorkflowJson,
  ex04 as WorkflowJson,
  ex05 as WorkflowJson,
  ex06 as WorkflowJson,
  ex07 as WorkflowJson,
  ex08 as WorkflowJson,
  ex09 as WorkflowJson,
  ex10 as WorkflowJson,
  ex11 as WorkflowJson,
  ex12 as WorkflowJson,
  ex13 as WorkflowJson,
  ex14 as WorkflowJson,
];

export {
  ex01, ex02, ex03, ex04, ex05, ex06, ex07,
  ex08, ex09, ex10, ex11, ex12, ex13, ex14,
};
