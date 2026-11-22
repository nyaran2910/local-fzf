import { Action, ActionPanel, environment, getPreferenceValues, Icon, List, openExtensionPreferences } from "@raycast/api";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname } from "node:path";
import { useEffect, useMemo, useRef, useState } from "react";
import { CandidateOptions, candidateRules, indexPath, readCustomRoots, refreshIndex, ResultType, resultTypes } from "./candidates";
import { findFzf, searchIndex } from "./fzf";

interface Settings {
  defaultScope: "home" | "custom" | "disk";
  customRoots?: string;
  defaultType: ResultType;
  includeGlobs?: string;
  excludeGlobs?: string;
  excludeRegex?: string;
  includeHidden: boolean;
  matchMode: "fuzzy" | "exact";
  fzfPath?: string;
}

interface SearchLocation {
  path: string;
  title: string;
}

interface IndexState {
  file: string;
  revision?: number;
  refreshing: boolean;
  error?: string;
}

const typeLabels: Record<ResultType, string> = {
  both: "Files and Folders",
  files: "Files",
  folders: "Folders",
};
const minimumRefreshInterval = 30_000;

function displayPath(path: string) {
  const home = homedir();
  return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

function locations(custom: string[]): SearchLocation[] {
  const home = homedir();
  return [
    { path: home, title: "Home" },
    ...custom.filter((path) => path !== home && path !== "/").map((path) => ({ path, title: displayPath(path) })),
    { path: "/", title: "Entire Disk" },
  ];
}

function PreferencesAction() {
  return <Action title="Open Extension Settings" icon={Icon.Gear} onAction={openExtensionPreferences} />;
}

export default function Command() {
  const [settings] = useState(() => getPreferenceValues<Settings>());
  let custom: string[];
  try {
    custom = readCustomRoots(settings.customRoots);
    candidateRules({ ...settings, root: homedir(), type: settings.defaultType });
  } catch (error) {
    return (
      <List navigationTitle="Local FZF">
        <List.EmptyView
          title="Check Search Settings"
          description={(error as Error).message}
          actions={<ActionPanel><PreferencesAction /></ActionPanel>}
        />
      </List>
    );
  }
  return <Search settings={settings} customRoots={custom} />;
}

function Search({ settings, customRoots }: { settings: Settings; customRoots: string[] }) {
  const roots = locations(customRoots);
  const [root, setRoot] = useState(() => {
    if (settings.defaultScope === "disk") return "/";
    if (settings.defaultScope === "custom") return customRoots[0] ?? homedir();
    return homedir();
  });
  const [type, setType] = useState<ResultType>(settings.defaultType ?? "both");
  const [query, setQuery] = useState("");
  const [binary, setBinary] = useState<{ path?: string; error?: string }>({});
  const [index, setIndex] = useState<IndexState>();
  const [result, setResult] = useState<{ file: string; paths: string[]; error?: string }>();
  const [searching, setSearching] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const consumedRefresh = useRef(0);

  const options = useMemo<CandidateOptions>(() => ({
    root,
    type,
    includeHidden: settings.includeHidden,
    includeGlobs: settings.includeGlobs,
    excludeGlobs: settings.excludeGlobs,
    excludeRegex: settings.excludeRegex,
  }), [root, type, settings]);
  const file = indexPath(environment.supportPath, options);

  useEffect(() => {
    let active = true;
    void findFzf(settings.fzfPath).then(
      (path) => { if (active) setBinary({ path }); },
      (error: Error) => { if (active) setBinary({ error: error.message }); },
    );
    return () => { active = false; };
  }, [settings.fzfPath]);

  useEffect(() => {
    if (!binary.path) return;
    const controller = new AbortController();
    const { signal } = controller;
    const forced = refresh !== consumedRefresh.current;
    consumedRefresh.current = refresh;
    setIndex((previous) => ({
      file,
      revision: previous?.file === file ? previous.revision : undefined,
      refreshing: true,
    }));

    void (async () => {
      let revision: number | undefined;
      try {
        const cached = await stat(file).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
          return undefined;
        });
        signal.throwIfAborted();
        revision = cached?.mtimeMs;
        const fresh = !forced && revision !== undefined && Date.now() - revision < minimumRefreshInterval;
        setIndex({ file, revision, refreshing: !fresh });
        if (fresh) return;

        await refreshIndex(file, options, signal);
        const updated = await stat(file);
        if (!signal.aborted) setIndex({ file, revision: updated.mtimeMs, refreshing: false });
      } catch (error) {
        if (!signal.aborted) setIndex({ file, revision, refreshing: false, error: (error as Error).message });
      }
    })();

    return () => controller.abort();
  }, [binary.path, file, options, refresh]);

  const revision = index?.file === file ? index.revision : undefined;
  useEffect(() => {
    if (!binary.path || revision === undefined) {
      setSearching(false);
      return;
    }

    const controller = new AbortController();
    const { signal } = controller;
    setSearching(true);
    void searchIndex(file, query, binary.path, settings.matchMode === "exact", signal)
      .then((paths) => { if (!signal.aborted) setResult({ file, paths }); })
      .catch((error: Error) => {
        if (!signal.aborted) setResult({ file, paths: [], error: error.message });
      })
      .finally(() => { if (!signal.aborted) setSearching(false); });

    return () => controller.abort();
  }, [file, revision, query, binary.path, settings.matchMode]);

  const current = result?.file === file ? result : undefined;
  const indexError = index?.file === file ? index.error : undefined;
  const error = binary.error ?? current?.error ?? indexError;
  const loading = !error && (searching || index?.file !== file || index.refreshing);
  const refreshAction = (
    <Action title="Refresh Search Index" icon={Icon.ArrowClockwise} onAction={() => setRefresh((value) => value + 1)} />
  );

  return (
    <List
      navigationTitle="Local FZF"
      filtering={false}
      isLoading={loading}
      onSearchTextChange={setQuery}
      searchBarPlaceholder="Search paths with fzf…"
      searchBarAccessory={
        <List.Dropdown
          tooltip="Search Location and Result Type"
          value={JSON.stringify([root, type])}
          onChange={(value) => {
            const [nextRoot, nextType] = JSON.parse(value) as [string, ResultType];
            setRoot(nextRoot);
            setType(nextType);
          }}
        >
          {roots.map((location) => (
            <List.Dropdown.Section key={location.path} title={location.title}>
              {resultTypes.map((kind) => (
                <List.Dropdown.Item
                  key={kind}
                  title={`${location.title} · ${typeLabels[kind]}`}
                  value={JSON.stringify([location.path, kind])}
                />
              ))}
            </List.Dropdown.Section>
          ))}
        </List.Dropdown>
      }
    >
      <List.EmptyView
        title={error ? "Search Unavailable" : loading ? "Searching…" : query.trim() ? "No Matches" : "No Files or Folders"}
        description={error}
        actions={<ActionPanel>{refreshAction}<PreferencesAction /></ActionPanel>}
      />
      {indexError && !!current?.paths.length && (
        <List.Section title="Search Index">
          <List.Item
            title="Couldn’t Refresh the Search Index"
            subtitle={indexError}
            icon={Icon.ExclamationMark}
            actions={<ActionPanel>{refreshAction}<PreferencesAction /></ActionPanel>}
          />
        </List.Section>
      )}
      <List.Section title="Results">
        {current?.paths.map((path) => (
          <List.Item
            key={path}
            title={basename(path)}
            subtitle={displayPath(dirname(path))}
            icon={{ fileIcon: path }}
            quickLook={{ path }}
            actions={
              <ActionPanel>
                <Action.Open title="Open" target={path} />
                <Action.ShowInFinder path={path} />
                <Action.CopyToClipboard title="Copy Path" content={path} shortcut={{ modifiers: ["cmd"], key: "c" }} />
                {refreshAction}
                <PreferencesAction />
              </ActionPanel>
            }
          />
        ))}
      </List.Section>
    </List>
  );
}
