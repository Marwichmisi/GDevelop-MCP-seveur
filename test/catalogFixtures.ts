import type { CatalogSource, CatalogSourceSnapshot } from '../src/catalogSource.js';

/**
 * Catalogue fixtures (ticket #15). The sources replicate the real GDevelop
 * builder syntax (see `docs/research/gdevelop-mcp-catalogue-research.md` §1)
 * at a small scale, so the unit suite never needs the network.
 */

export const FIXTURE_CPP_PATH = 'Core/GDCore/Extensions/Builtin/VariablesExtension.cpp';

export const FIXTURE_CPP = `#include "AllBuiltinExtensions.h"

namespace gd {

void GD_CORE_API BuiltinExtensionsImplementer::ImplementsVariablesExtension(
    gd::PlatformExtension& extension) {
  extension
      .SetExtensionInformation(
          "BuiltinVariables",
          _("Variables"),
          _("Support for variables in scenes, objects and projects."),
          "Florian Rival",
          "Open source (MIT License)")
      .SetShortDescription("Handle numeric, text and boolean variables.");
  extension
      .AddAction("ModVarScene",
                 _("Modify the value of a scene variable"),
                 _("Change the value of the specified scene variable."),
                 _("Do _PARAM1_ _PARAM0_ to _PARAM2_"),
                 "",
                 "res/conditions/var24.png",
                 "res/conditions/var.png")
      .AddParameter("scenevar", _("Variable"))
      .AddParameter("operator", _("Modification's sign"))
      .AddParameter("expression", _("Value"));
  extension
      .AddStrExpression("VariableString",
                        _("Scene variable value"),
                        _("Return the text of a scene variable."),
                        "",
                        "res/conditions/var24.png")
      .AddParameter("scenevar", _("Variable"));
  extension
      .AddExpressionAndCondition("string",
                                 "VariableBranch",
                                 _("Scene variable text"),
                                 _("Return the text of a scene variable, or check it."),
                                 _("Scene variable _PARAM0_"),
                                 "Variables",
                                 "res/conditions/var24.png")
      .AddParameter("scenevar", _("Variable"));
}

}  // namespace gd
`;

export const FIXTURE_JS_PATH = 'Extensions/DialogueTree/JsExtension.js';

export const FIXTURE_JS = `//@ts-check
module.exports = {
  createExtension: function (_, gd) {
    const extension = new gd.PlatformExtension();
    extension
      .setExtensionInformation(
        'DialogueTree',
        _('Dialogue Tree'),
        _('Implements dialogue trees for stories.'),
        'GDevelop',
        'MIT'
      )
      .setShortDescription('Branching dialogues for games.');
    extension
      .addAction(
        'ChangeDialogueBranch',
        _('Change the dialogue branch'),
        _('Changes the dialogue branch to another one.'),
        _('Change the dialogue branch to _PARAM1_'),
        '',
        'res/actions/dialogue24.png',
        'res/actions/dialogue.png'
      )
      .addParameter('scenevar', _('Dialogue branch'), '', false)
      .addCodeOnlyParameter('currentScene', '');
    const hero = extension
      .addObject(
        'Hero',
        _('Hero'),
        _('The story hero.'),
        'res/actions/dialogue.png',
        dummyObject
      );
    hero.addAction(
      'SetQuestDone',
      _('Mark the quest as done'),
      _('Marks the hero quest as done.'),
      _('Mark the quest of _PARAM0_ as done'),
      '',
      'res/actions/dialogue24.png',
      'res/actions/dialogue.png'
    )
      .addParameter('object', _('Object'), 'Hero', false);
    extension
      .addBehavior(
        'QuestTracker',
        _('Quest tracker'),
        'QuestTracker',
        _('Tracks hero quests.'),
        '',
        'res/conditions/quest24.png',
        'QuestTracker',
        dummyBehavior,
        new gd.BehaviorsSharedData()
      );
    return extension;
  },
};
`;

export const FIXTURE_TS_PATH = 'Extensions/DialogueTree/dialoguetools.ts';

export const FIXTURE_TS = `// Runtime helpers for the DialogueTree extension.
// Custom declarations driven by events, serialized as eventsBasedObject: Companion.
namespace gdjs {
  export class EventsBasedObjectCompanion {}
}
`;

export interface FixtureSourceOptions {
  ref?: string;
  sha?: string | null;
  syncedAt?: string;
  latestRef?: string | null;
  files?: { path: string; source: string }[];
}

/** In-memory `CatalogSource`: deterministic, no network, with call counters. */
export function makeFixtureSource(options: FixtureSourceOptions = {}): CatalogSource & {
  loads: number;
  refreshes: number;
  latestChecks: number;
  snapshot: CatalogSourceSnapshot;
} {
  const source: CatalogSource & {
    loads: number;
    refreshes: number;
    latestChecks: number;
    snapshot: CatalogSourceSnapshot;
  } = {
    loads: 0,
    refreshes: 0,
    latestChecks: 0,
    snapshot: {
      ref: options.ref ?? 'v5.6.282',
      sha: options.sha === undefined ? 'abc123tree' : options.sha,
      syncedAt: options.syncedAt ?? '2026-09-12T00:00:00.000Z',
      files: options.files ?? [
        { path: FIXTURE_CPP_PATH, source: FIXTURE_CPP },
        { path: FIXTURE_JS_PATH, source: FIXTURE_JS },
        { path: FIXTURE_TS_PATH, source: FIXTURE_TS },
      ],
    },
    async load(loadOptions: { refresh?: boolean | undefined } = {}): Promise<CatalogSourceSnapshot> {
      source.loads += 1;
      if (loadOptions.refresh === true) source.refreshes += 1;
      return source.snapshot;
    },
    async latestReleaseRef(): Promise<string | null> {
      source.latestChecks += 1;
      return options.latestRef === undefined ? (options.ref ?? 'v5.6.282') : options.latestRef;
    },
  };
  return source;
}
