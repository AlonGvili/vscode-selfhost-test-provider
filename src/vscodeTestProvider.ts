/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { SourceMapConsumer } from 'source-map';
import {
  CancellationToken,
  Location,
  MarkdownString,
  OutputChannel,
  Position,
  ProviderResult,
  Range,
  TestMessage,
  TestProvider,
  TestResultState,
  TestRunOptions,
  TextDocument,
  Uri,
  window,
  workspace,
  WorkspaceFolder,
} from 'vscode';
import { MochaEvent, TestOutputScanner } from './testOutputScanner';
import {
  DocumentTestRoot,
  getContentsFromFile,
  TestCase,
  TestFile,
  TestRoot,
  VSCodeTest,
  WorkspaceTestRoot,
} from './testTree';
import { PlatformTestRunner } from './vscodeTestRunner';

export class VscodeTestProvider implements TestProvider<VSCodeTest> {
  private outputChannel?: OutputChannel;
  private queue = Promise.resolve();

  /**
   * @inheritdoc
   */
  public getParent(test: VSCodeTest): VSCodeTest | undefined {
    return test.parent;
  }

  /**
   * @inheritdoc
   */
  public provideWorkspaceTestRoot(workspaceFolder: WorkspaceFolder): ProviderResult<VSCodeTest> {
    return new WorkspaceTestRoot(workspaceFolder);
  }

  /**
   * @inheritdoc
   */
  public provideDocumentTestRoot(document: TextDocument): ProviderResult<VSCodeTest> {
    const folder = workspace.getWorkspaceFolder(document.uri);
    if (!folder) {
      return;
    }

    return new DocumentTestRoot(folder, document);
  }

  public async runTests(req: TestRunOptions<VSCodeTest>, cancellationToken: CancellationToken) {
    let maybeRoot = req.tests[0];
    while (!(maybeRoot instanceof TestRoot)) {
      maybeRoot = maybeRoot.parent;
    }

    const root = maybeRoot as TestRoot;
    const runner = new PlatformTestRunner(root.workspaceFolder);

    const pending = await getPendingTestMap(req.tests);
    return (this.queue = this.queue.then(async () => {
      const output = this.getOutputChannel();
      output.appendLine('');
      output.appendLine(`Starting test run at ${new Date().toLocaleString()}`);
      output.appendLine('');

      const outcome = await scanTestOutput(
        output,
        req,
        req.debug ? await runner.debug(req.tests) : await runner.run(req.tests),
        pending,
        cancellationToken
      );

      // some error:
      if (outcome !== TestResultState.Skipped) {
        output.show();
      }
    }));
  }

  private getOutputChannel() {
    if (!this.outputChannel) {
      this.outputChannel = window.createOutputChannel('VS Code Tests');
    }

    return this.outputChannel;
  }
}

function scanTestOutput(
  outputChannel: OutputChannel,
  req: TestRunOptions<VSCodeTest>,
  scanner: TestOutputScanner,
  tests: Map<string, TestCase>,
  cancellation: CancellationToken
): Promise<TestResultState> {
  if (cancellation.isCancellationRequested) {
    scanner.dispose();
    return Promise.resolve(TestResultState.Skipped);
  }

  return new Promise<TestResultState>(resolve => {
    cancellation.onCancellationRequested(() => {
      resolve(TestResultState.Skipped);
    });

    scanner.onRunnerError(err => {
      outputChannel.appendLine(err);
      resolve(TestResultState.Errored);
    });

    scanner.onOtherOutput(str => {
      outputChannel.appendLine(str);
    });

    scanner.onMochaEvent(evt => {
      switch (evt[0]) {
        case MochaEvent.Start:
          break; // no-op
        case MochaEvent.Pass:
          {
            const title = evt[1].fullTitle;
            const tcase = tests.get(title);
            outputChannel.appendLine(` √ ${title}`);
            if (tcase) {
              req.setState(tcase, TestResultState.Passed, evt[1].duration);
              tests.delete(title);
            }
          }
          break;
        case MochaEvent.Fail:
          {
            const { err, stack, duration, expected, actual, fullTitle: id } = evt[1];
            const tcase = tests.get(id);
            outputChannel.appendLine(` x ${id}`);
            if (!tcase) {
              return;
            }

            tests.delete(id);
            const testFirstLine = new Location(
              tcase.uri,
              new Range(tcase.range.start, new Position(tcase.range.start.line, 100))
            );

            tryDeriveLocation(stack || err).then(location => {
              const message = new TestMessage(tryMakeMarkdown(err));
              message.location = location ?? testFirstLine;
              message.actualOutput = String(actual);
              message.expectedOutput = String(expected);
              req.appendMessage(tcase, message);
              req.setState(tcase, TestResultState.Failed, duration);
              outputChannel.appendLine(stack || err);
            });
          }
          break;
        case MochaEvent.End:
          resolve(TestResultState.Skipped);
          break;
      }
    });
  }).finally(() => scanner.dispose());
}

const tryMakeMarkdown = (message: string) => {
  const lines = message.split('\n');
  const start = lines.findIndex(l => l.includes('+ actual'));
  if (start === -1) {
    return message;
  }

  lines.splice(start, 1, '```diff');
  lines.push('```');
  return new MarkdownString(lines.join('\n'));
};

async function tryDeriveLocation(stack: string) {
  const parts = /(file:\/{3}.+):([0-9]+):([0-9]+)/.exec(stack);
  if (!parts) {
    return;
  }

  const [, fileUri, line, col] = parts;
  let sourceMap: SourceMapConsumer;
  try {
    const sourceMapUri = fileUri + '.map';
    const contents = await getContentsFromFile(Uri.parse(sourceMapUri));
    sourceMap = await new SourceMapConsumer(contents, sourceMapUri);
  } catch (e) {
    console.warn(`Error parsing sourcemap for ${fileUri}: ${e.stack}`);
    return;
  }

  const position = sourceMap.originalPositionFor({
    column: Number(col) - 1,
    line: Number(line),
  });

  if (position.line === null || position.column === null || position.source === null) {
    return;
  }

  return new Location(Uri.parse(position.source), new Position(position.line - 1, position.column));
}

async function getPendingTestMap(tests: ReadonlyArray<VSCodeTest>) {
  const queue: Iterable<VSCodeTest>[] = [tests];
  const titleMap = new Map<string, TestCase>();
  while (queue.length) {
    for (const child of queue.pop()!) {
      if (child instanceof TestFile) {
        await child.refresh();
        queue.push(child.children);
      } else if (child instanceof TestCase) {
        titleMap.set(child.fullLabel, child);
      } else {
        queue.push(child.children);
      }
    }
  }

  return titleMap;
}
