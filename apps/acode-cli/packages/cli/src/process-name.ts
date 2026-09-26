export const CLI_COMMAND_NAME = "acode";
export const CLI_PROCESS_NAME = "acode-cli";

interface ProcessTitleTarget {
  title: string;
}

export const setCliProcessTitle = (
  target: ProcessTitleTarget = process,
): void => {
  target.title = CLI_PROCESS_NAME;
};
