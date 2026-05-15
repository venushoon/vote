export interface Option {
  id: string;
  label: string;
}

export interface PollData {
  pollId: string;
  options: Option[];
  expectedVoters: number;
  manualClosed: boolean;
  visibilityMode: 'always' | 'deadline' | 'closed';
  deadlineAt: number;
  ballots: Record<string, string>; // deviceToken: optionId
}

export interface AdminViewProps {
  poll: PollData;
  setOptionLabel: (id: string, label: string) => void;
  updatePoll: (updates: Partial<PollData>) => Promise<void>;
  loadFromFile: (file: File) => void;
  studentLink: string;
}

export interface StudentViewProps {
  poll: PollData;
  submitVote: (optionId: string) => Promise<{ committed: boolean; error?: string }>;
  now: number;
}
