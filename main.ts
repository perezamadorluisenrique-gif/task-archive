import { App, Editor, MarkdownView, Notice, Plugin, PluginSettingTab, Setting, TFile, moment, normalizePath } from 'obsidian';
import type { SettingDefinitionItem } from 'obsidian';

import { applyChanges, findCompleted, planFor, planInsertion, planRemoval, splitLines, taskAround } from './src/archive.ts';
import type { ArchiveOptions, Block, Change } from './src/archive.ts';

/** The part of moment this plugin uses, typed here: the directory's review has no types for `moment`. */
interface Day {
  format(pattern: string): string;
}
const today = moment as unknown as () => Day;

interface TaskArchiveSettings {
  /** Checkbox characters that mean finished. */
  doneMarkers: string;
  /** Text of the archive heading. */
  heading: string;
  headingLevel: number;
  /** Group what is archived under a heading with the day's date. */
  groupByDate: boolean;
  dateFormat: string;
  /** Also archive finished tasks under an unfinished one. */
  includeNested: boolean;
  /** Path of a note that receives the tasks. Empty: the same note. */
  archiveNote: string;
}

const DEFAULT_SETTINGS: TaskArchiveSettings = {
  doneMarkers: 'xX',
  heading: 'Archive',
  headingLevel: 2,
  groupByDate: true,
  dateFormat: 'YYYY-MM-DD',
  includeNested: true,
  archiveNote: '',
};

const LEVELS = { '1': 'Heading 1', '2': 'Heading 2', '3': 'Heading 3', '4': 'Heading 4' };

/** Names and descriptions shared by the 1.13+ declarative tab and the older `display()`. */
const TEXT = {
  doneMarkers: { name: 'Finished markers', desc: 'Checkbox characters that mean finished, without spaces. For example xX- also archives [-].' },
  includeNested: {
    name: 'Archive finished sub-tasks of open tasks',
    desc: 'Off: a finished task inside an unfinished one stays until its parent is finished too.',
  },
  archiveNote: {
    name: 'Archive note',
    desc: 'Path of a note that receives the tasks, such as Archive/Tasks.md. Created if missing. Leave empty to archive inside the same note.',
  },
  heading: { name: 'Archive heading', desc: 'The tasks go at the end of this section, created at the end of the note if missing.' },
  headingLevel: { name: 'Heading level', desc: 'Level of the archive heading.' },
  groupByDate: { name: 'Group by date', desc: 'Put the tasks under a smaller heading with today’s date, reused when you archive again the same day.' },
  dateFormat: { name: 'Date format', desc: 'For the date heading, for example YYYY-MM-DD.' },
};

type Key = keyof TaskArchiveSettings;

export default class TaskArchivePlugin extends Plugin {
  settings: TaskArchiveSettings = { ...DEFAULT_SETTINGS };

  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, (await this.loadData()) as Partial<TaskArchiveSettings> | null);
    this.addSettingTab(new TaskArchiveSettingTab(this.app, this));

    this.addCommand({
      id: 'archive-completed',
      name: 'Archive completed tasks',
      icon: 'archive',
      callback: () => void this.fromActive('completed'),
    });
    this.addCommand({
      id: 'archive-task',
      name: 'Archive the current task',
      icon: 'square-check',
      editorCallback: (editor: Editor, view) => void this.archive(view.file, editor, 'task'),
    });

    this.registerEvent(
      this.app.workspace.on('file-menu', (menu, file) => {
        if (!(file instanceof TFile) || file.extension !== 'md') return;
        menu.addItem((item) => item.setTitle('Archive completed tasks').setIcon('archive').onClick(() => void this.archive(file, null, 'completed')));
      }),
    );
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  private options(): ArchiveOptions {
    const s = this.settings;
    const format = s.dateFormat.trim() || DEFAULT_SETTINGS.dateFormat;
    return {
      doneMarkers: s.doneMarkers || DEFAULT_SETTINGS.doneMarkers,
      heading: s.heading.trim() || DEFAULT_SETTINGS.heading,
      level: Math.min(Math.max(Math.round(s.headingLevel) || 2, 1), 6),
      dateHeading: s.groupByDate ? today().format(format) : '',
      includeNested: s.includeNested,
    };
  }

  /** The archive note, when one is set and it is not the note being archived. */
  private archivePath(file: TFile): string | null {
    const p = normalizePath(this.settings.archiveNote.trim());
    if (!this.settings.archiveNote.trim() || p === file.path) return null;
    return p.endsWith('.md') ? p : `${p}.md`;
  }

  private fromActive(what: 'completed' | 'task') {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view?.file) {
      new Notice('Open a note first.');
      return;
    }
    return this.archive(view.file, view.getMode() === 'source' ? view.editor : null, what);
  }

  /** Archives in the open editor when there is one, otherwise straight in the file. */
  async archive(file: TFile | null, editor: Editor | null, what: 'completed' | 'task') {
    if (!file) return;
    try {
      const opts = this.options();
      const text = editor ? editor.getValue() : await this.app.vault.read(file);
      const lines = splitLines(text);
      let found: Block[];
      if (what === 'task') {
        const at = editor ? editor.getCursor('from').line : 0;
        const block = taskAround(lines, at);
        found = block ? [block] : [];
        if (!block) {
          new Notice('Click inside a task first.');
          return;
        }
      } else {
        const from = editor?.somethingSelected() ? editor.getCursor('from').line : 0;
        let to = lines.length;
        if (editor?.somethingSelected()) {
          const end = editor.getCursor('to');
          to = end.ch === 0 && end.line > from ? end.line : end.line + 1;
        }
        found = findCompleted(lines, opts, from, to);
      }
      if (found.length === 0) {
        new Notice(editor?.somethingSelected() ? 'No completed tasks in the selection.' : 'No completed tasks to archive.');
        return;
      }

      const other = this.archivePath(file);
      let changes: Change[];
      let blocks: string[][];
      if (other) {
        blocks = found.map((b) => b.lines);
        changes = planRemoval(text, found, lines);
        await this.addToArchiveNote(other, blocks, opts);
      } else {
        const plan = planFor(text, lines, found, opts);
        if (!plan) return;
        changes = plan.changes;
        blocks = plan.blocks;
      }

      if (editor) {
        if (editor.getValue() !== text) {
          new Notice('The note changed while archiving. Nothing was removed from it; run the command again.');
          return;
        }
        editor.transaction({
          changes: changes.map((c) => ({ from: editor.offsetToPos(c.from), to: editor.offsetToPos(c.to), text: c.insert })),
        });
      } else {
        let changed = true;
        await this.app.vault.process(file, (data) => {
          if (data !== text) {
            changed = false;
            return data;
          }
          return applyChanges(data, changes);
        });
        if (!changed) {
          new Notice('The note changed while archiving. Nothing was removed from it; run the command again.');
          return;
        }
      }
      new Notice(`Archived ${found.length} ${found.length === 1 ? 'task' : 'tasks'}${other ? ` to “${other}”` : ''}.`);
    } catch (e) {
      console.error('plugin:task-archive', e);
      new Notice('Could not archive the tasks. Nothing was removed.');
    }
  }

  private async addToArchiveNote(path: string, blocks: string[][], opts: ArchiveOptions) {
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) {
      await this.app.vault.process(existing, (data) => {
        const c = planInsertion(data, blocks, opts);
        return c ? applyChanges(data, [c]) : data;
      });
      return;
    }
    if (existing) throw new Error(`${path} is a folder`);
    const folder = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    if (folder && !this.app.vault.getAbstractFileByPath(folder)) await this.app.vault.createFolder(folder);
    const c = planInsertion('', blocks, opts);
    await this.app.vault.create(path, c ? c.insert : '');
  }
}

class TaskArchiveSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private plugin: TaskArchivePlugin,
  ) {
    super(app, plugin);
  }

  /**
   * The settings, described rather than drawn. Obsidian 1.13 and later
   * renders this itself and indexes it for the settings search. Older
   * versions ignore it and call `display()`.
   */
  getSettingDefinitions(): SettingDefinitionItem[] {
    const s = this.plugin.settings;
    const d = DEFAULT_SETTINGS;
    return [
      {
        type: 'group',
        heading: 'Which tasks',
        items: [
          { ...TEXT.doneMarkers, control: { type: 'text', key: 'doneMarkers', placeholder: 'xX', defaultValue: d.doneMarkers } },
          { ...TEXT.includeNested, control: { type: 'toggle', key: 'includeNested', defaultValue: d.includeNested } },
        ],
      },
      {
        type: 'group',
        heading: 'Where they go',
        items: [
          { ...TEXT.archiveNote, control: { type: 'text', key: 'archiveNote', placeholder: 'Archive/Tasks.md', defaultValue: '' } },
          { ...TEXT.heading, control: { type: 'text', key: 'heading', placeholder: 'Archive', defaultValue: d.heading } },
          { ...TEXT.headingLevel, control: { type: 'dropdown', key: 'headingLevel', options: LEVELS, defaultValue: String(d.headingLevel) } },
          { ...TEXT.groupByDate, control: { type: 'toggle', key: 'groupByDate', defaultValue: d.groupByDate } },
          {
            ...TEXT.dateFormat,
            visible: () => s.groupByDate,
            control: { type: 'text', key: 'dateFormat', placeholder: 'YYYY-MM-DD', defaultValue: d.dateFormat },
          },
        ],
      },
    ];
  }

  getControlValue(key: string): unknown {
    const v = (this.plugin.settings as unknown as Record<string, unknown>)[key];
    return key === 'headingLevel' ? String(v) : v;
  }

  async setControlValue(key: string, value: unknown): Promise<void> {
    const s = this.plugin.settings;
    if (key === 'headingLevel') s.headingLevel = Number(value) || DEFAULT_SETTINGS.headingLevel;
    else if (key === 'doneMarkers') s.doneMarkers = String(value).replace(/\s/g, '');
    else Object.assign(s, { [key]: value });
    await this.plugin.saveSettings();
    // Obsidian 1.13's re-check of `visible`, looked up because older versions lack it.
    if (key === 'groupByDate') (this as unknown as { refreshDomState?: () => void }).refreshDomState?.();
  }

  /** The pre-1.13 rendering, from the same text. Obsidian skips it once `getSettingDefinitions()` returns anything. */
  display(): void {
    const { containerEl } = this;
    const s = this.plugin.settings;
    containerEl.empty();
    new Setting(containerEl).setName('Which tasks').setHeading();
    this.text('doneMarkers');
    this.toggle('includeNested');
    new Setting(containerEl).setName('Where they go').setHeading();
    this.text('archiveNote');
    this.text('heading');
    new Setting(containerEl)
      .setName(TEXT.headingLevel.name)
      .setDesc(TEXT.headingLevel.desc)
      .addDropdown((d) =>
        d
          .addOptions(LEVELS)
          .setValue(String(s.headingLevel))
          .onChange((v) => void this.setControlValue('headingLevel', v)),
      );
    new Setting(containerEl)
      .setName(TEXT.groupByDate.name)
      .setDesc(TEXT.groupByDate.desc)
      .addToggle((t) =>
        t.setValue(s.groupByDate).onChange(async (v) => {
          await this.setControlValue('groupByDate', v);
          this.display();
        }),
      );
    if (s.groupByDate) this.text('dateFormat');
  }

  private text(key: 'doneMarkers' | 'archiveNote' | 'heading' | 'dateFormat') {
    new Setting(this.containerEl)
      .setName(TEXT[key].name)
      .setDesc(TEXT[key].desc)
      .addText((t) =>
        t
          .setPlaceholder(String(DEFAULT_SETTINGS[key]))
          .setValue(String(this.plugin.settings[key]))
          .onChange((v) => void this.setControlValue(key, v)),
      );
  }

  private toggle(key: Key & 'includeNested') {
    new Setting(this.containerEl)
      .setName(TEXT[key].name)
      .setDesc(TEXT[key].desc)
      .addToggle((t) => t.setValue(this.plugin.settings[key]).onChange((v) => void this.setControlValue(key, v)));
  }
}
