import { Table2, HardDrive } from 'lucide-react';
import type { NodeDef } from '../types';

export const airtableNode: NodeDef = {
  type: 'n8n-nodes-base.airtable',
  label: 'Airtable',
  category: 'storage',
  description: 'Read, create, update, or delete Airtable records.',
  icon: Table2,
  iconColor: 'bg-yellow-100 text-yellow-700',
  credentialProvider: 'airtable',
  fields: [
    {
      key: 'baseId',
      label: 'Base ID',
      type: 'text',
      required: true,
      placeholder: 'appXXXXXXXXXXXXXX',
      description: 'Found in your Airtable base URL.',
    },
    {
      key: 'tableId',
      label: 'Table ID',
      type: 'text',
      required: true,
      placeholder: 'tblXXXXXXXXXXXXXX',
    },
    {
      key: 'operation',
      label: 'Operation',
      type: 'select',
      required: true,
      default: 'list',
      options: [
        { label: 'List Records', value: 'list' },
        { label: 'Get Record', value: 'get' },
        { label: 'Create Record', value: 'create' },
        { label: 'Update Record', value: 'update' },
        { label: 'Delete Record', value: 'delete' },
      ],
    },
    {
      key: 'recordId',
      label: 'Record ID',
      type: 'text',
      placeholder: 'recXXXXXXXXXXXXXX',
      description: 'Required for Get, Update, and Delete operations.',
    },
    {
      key: 'filterFormula',
      label: 'Filter Formula',
      type: 'text',
      placeholder: "NOT({Status} = 'Done')",
      description: 'Airtable formula to filter records. Only applies to List operation.',
    },
    {
      key: 'fields',
      label: 'Fields to Return',
      type: 'text',
      placeholder: 'Name, Email, Status',
      description: 'Comma-separated field names. Leave blank for all fields. For Create/Update, record field values are taken from the incoming data instead.',
    },
  ],
};

export const googleDriveNode: NodeDef = {
  type: 'n8n-nodes-base.googleDrive',
  label: 'Google Drive',
  category: 'storage',
  description: 'Upload, download, or manage files in Google Drive.',
  icon: HardDrive,
  iconColor: 'bg-sky-100 text-sky-700',
  // Phase 9.1.6: credential injection for Google Drive isn't implemented yet.
  unavailableReason: 'Google Drive isn\'t connected yet.',
  fields: [
    {
      key: 'operation',
      label: 'Operation',
      type: 'select',
      required: true,
      default: 'list',
      options: [
        { label: 'List Files', value: 'list' },
        { label: 'Upload File', value: 'upload' },
        { label: 'Download File', value: 'download' },
        { label: 'Delete File', value: 'delete' },
        { label: 'Create Folder', value: 'createFolder' },
      ],
    },
    {
      key: 'folderId',
      label: 'Folder ID',
      type: 'text',
      placeholder: '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs',
      description: 'Google Drive folder ID. Leave blank for root.',
    },
    {
      key: 'fileName',
      label: 'File Name',
      type: 'text',
      placeholder: 'report.pdf',
    },
  ],
};
