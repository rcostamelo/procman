'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { NAME } = require('./constants');

/**
 * Tab-completion for bash and zsh.
 *
 * The scripts are deliberately thin: instead of embedding the command list in
 * the shell (and having it go stale on the next release), they ask the CLI:

 *   procman __complete commands|options|targets|namespaces|users|ecosystems
 *
 * which prints one candidate per line. The shell also gets the static things
 * (option values such as fork|cluster) inline, because that costs nothing.
 */

const MARK_START = `# >>> ${NAME} completion >>>`;
const MARK_END = `# <<< ${NAME} completion <<<`;

const BASH_FUNCTION = `_${NAME}_complete() {
  local cur prev cmd
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  cmd="\${COMP_WORDS[1]}"

  case "$prev" in
    --namespace) COMPREPLY=($(compgen -W "$(${NAME} __complete namespaces)" -- "$cur")); return ;;
    --mode)      COMPREPLY=($(compgen -W "fork cluster" -- "$cur")); return ;;
    --sort)      COMPREPLY=($(compgen -W "cpu mem name id" -- "$cur")); return ;;
    --user)      COMPREPLY=($(compgen -W "$(${NAME} __complete users)" -- "$cur")); return ;;
    --stdin|--password) return ;;
    --lines)     COMPREPLY=($(compgen -W "20 50 200 1000" -- "$cur")); return ;;
    --instances|-i) COMPREPLY=($(compgen -W "max 1 2 4 number-of-cpus" -- "$cur")); return ;;
  esac

  if [[ "$cur" == -* ]]; then
    COMPREPLY=($(compgen -W "$(${NAME} __complete options)" -- "$cur"))
    return
  fi

  if [[ $COMP_CWORD -eq 1 ]]; then
    COMPREPLY=($(compgen -W "$(${NAME} __complete commands)" -- "$cur"))
    return
  fi

  case "$cmd" in
    list|ls|status|describe|desc|stop|restart|reload|delete|del|scale|logs|log)
      COMPREPLY=($(compgen -W "$(${NAME} __complete targets)" -- "$cur")) ;;
    help)
      COMPREPLY=($(compgen -W "$(${NAME} __complete commands)" -- "$cur")) ;;
    completion)
      COMPREPLY=($(compgen -W "bash zsh" -- "$cur")) ;;
    web)
      COMPREPLY=($(compgen -W "start stop" -- "$cur")) ;;
    user)
      if [[ $COMP_CWORD -eq 2 ]]; then
        COMPREPLY=($(compgen -W "list add passwd rm" -- "$cur"))
      elif [[ $COMP_CWORD -eq 3 ]]; then
        COMPREPLY=($(compgen -W "$(${NAME} __complete users)" -- "$cur"))
      fi ;;
    start)
      COMPREPLY=($(compgen -f -- "$cur") $(compgen -W "$(${NAME} __complete ecosystems)" -- "$cur")) ;;
    *)
      COMPREPLY=($(compgen -f -- "$cur")) ;;
  esac
}`;

const ZSH_FUNCTION = `_${NAME}_complete() {
  local cur prev cmd
  cur=\${words[CURRENT]}
  prev=\${words[CURRENT-1]}
  cmd=\${words[2]}
  local -a cands

  case "$prev" in
    --namespace) cands=(\${(f)"$(${NAME} __complete namespaces)"}); compadd -a cands; return ;;
    --mode)      compadd -- fork cluster; return ;;
    --sort)      compadd -- cpu mem name id; return ;;
    --user)      cands=(\${(f)"$(${NAME} __complete users)"}); compadd -a cands; return ;;
    --lines)     compadd -- 20 50 200 1000; return ;;
    --instances|-i) compadd -- max 1 2 4; return ;;
  esac

  if [[ "$cur" == -* ]]; then
    cands=(\${(f)"$(${NAME} __complete options)"}); compadd -a cands; return
  fi

  if (( CURRENT == 2 )); then
    cands=(\${(f)"$(${NAME} __complete commands)"}); compadd -a cands; return
  fi

  case "$cmd" in
    list|ls|status|describe|desc|stop|restart|reload|delete|del|scale|logs|log)
      cands=(\${(f)"$(${NAME} __complete targets)"}); compadd -a cands ;;
    help)
      cands=(\${(f)"$(${NAME} __complete commands)"}); compadd -a cands ;;
    completion)
      compadd -- bash zsh ;;
    user)
      if (( CURRENT == 3 )); then
        compadd -- list add passwd rm
      elif (( CURRENT == 4 )); then
        cands=(\${(f)"$(${NAME} __complete users)"}); compadd -a cands
      fi ;;
    *)
      (( $+functions[_files] )) && _files ;;
  esac
}`;

function bashScript() {
  return `# ${NAME} tab-completion for bash — install with: ${NAME} completion bash --install
${BASH_FUNCTION}

complete -o default -F _${NAME}_complete ${NAME}`;
}

function zshScript() {
  return `#compdef ${NAME}
# ${NAME} tab-completion for zsh — install with: ${NAME} completion zsh --install
${ZSH_FUNCTION}

compdef _${NAME}_complete ${NAME}`;
}

function scriptFor(shell) {
  if (shell === 'bash') return bashScript();
  if (shell === 'zsh') return zshScript();
  const err = new Error(`unsupported shell "${shell || ''}" — use bash or zsh`);
  err.code = 'USAGE';
  err.command = 'completion';
  throw err;
}

function rcFileFor(shell) {
  return path.join(os.homedir(), shell === 'zsh' ? '.zshrc' : '.bashrc');
}

function sourceLine(shell) {
  return shell === 'zsh' ? `source <(${NAME} completion zsh)` : `eval "$(${NAME} completion bash)"`;
}

function detectShell() {
  const base = path.basename(process.env.SHELL || '');
  return base === 'zsh' ? 'zsh' : base === 'bash' ? 'bash' : null;
}

/**
 * Appends a marked block to the shell rc. Idempotent: running it twice reports
 * "already there" instead of stacking copies, and the markers make it easy to
 * remove by hand.
 */
function install(shell) {
  const name = shell || detectShell();
  if (!name) {
    const err = new Error('could not tell which shell you use — say it: completion bash --install');
    err.code = 'USAGE';
    err.command = 'completion';
    throw err;
  }
  scriptFor(name); // validates the shell name
  const rc = rcFileFor(name);  const block = `${MARK_START}\n${sourceLine(name)}\n${MARK_END}\n`;
  let current = '';
  try {
    current = fs.readFileSync(rc, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  if (current.includes(MARK_START)) {
    return { shell: name, rc, changed: false, line: sourceLine(name) };
  }
  const prefix = current && !current.endsWith('\n') ? '\n' : '';
  fs.appendFileSync(rc, `${prefix}\n${block}`, 'utf8');
  return { shell: name, rc, changed: true, line: sourceLine(name) };
}

module.exports = { scriptFor, install, detectShell, rcFileFor, MARK_START, MARK_END };
