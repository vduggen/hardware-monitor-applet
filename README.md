# Hardware Monitor for Cinnamon

Um applet nativo e independente para o painel do Cinnamon. O painel exibe
indicadores compactos de CPU e RAM com barras verticais, temperatura e taxas de
download/upload. O popup reúne as métricas em cartões e mostra a memória usada e
total em GiB.

O indicador **DSK** mostra o percentual ocupado do sistema de arquivos de `/`.
O popup detalha o espaço usado, total e livre em GiB. Não soma outros discos ou
partições montadas separadamente. A consulta é assíncrona, a cada 30 segundos,
sem percorrer arquivos; o espaço livre inclui eventuais blocos reservados pelo
sistema de arquivos, não necessariamente disponíveis para usuários comuns.

## Compatibilidade

- Desenvolvido e validado localmente no Linux Mint 22.3, Cinnamon 6.6.9, X11.
- Não exige Node.js para funcionar: utiliza o runtime CJS do Cinnamon.
- O suporte a outros desktops, incluindo GNOME, ainda não está implementado.
- A disponibilidade e a identificação da temperatura dependem do hardware e dos
  drivers do kernel. A seleção do sensor é heurística.
- A rede acompanha uma interface por vez; o valor não é a soma de todas as
  interfaces. A seleção prefere a rota padrão IPv4.

## Coleta e comportamento

- Lê `/proc/stat`, `/proc/meminfo`, `/proc/net/dev` e `/proc/net/route`.
- Detecta sensores em `/sys/class/hwmon` e `/sys/class/thermal`; a descoberta é
  repetida a cada 60 segundos, não em cada atualização.
- Atualiza CPU/rede a cada segundo, RAM a cada 3 segundos e temperatura a cada
  5 segundos.
- O painel mostra medidores verticais de preenchimento para CPU e RAM, com a
  temperatura abaixo do percentual da CPU. No popup, gráficos de linha exibem
  até 60 amostras alinhadas (cerca de três minutos), apenas em memória.
- As barras ficam verdes abaixo de 70%, âmbar a partir de 70% e vermelhas a
  partir de 90%. A temperatura fica verde abaixo de 60 °C, âmbar a partir de
  60 °C e vermelha a partir de 80 °C; leituras indisponíveis usam tom neutro.
- Não executa comandos externos, não mantém daemon, histórico persistente ou
  telemetria.
- Se um sensor ou uma interface não estiver disponível, mostra `—` e continua
  funcionando.
- Para ao ser removido/desabilitado e recria os timers ao ser reabilitado.

## Testes

Requer Node.js apenas para executar os testes (não é dependência do applet):

```sh
npm test
```

O runtime do applet é o já fornecido pelo Cinnamon/GJS. O projeto não inclui
instalador e não instala nem habilita o applet automaticamente.

## Privacidade e publicação

As métricas são lidas apenas da máquina local. O applet não envia informações
pela rede nem grava o histórico em disco. As configurações do painel pertencem
ao perfil local do Cinnamon e não fazem parte deste projeto.

O repositório não inclui capturas de tela do ambiente pessoal, credenciais nem
arquivos de configuração do usuário. Antes de contribuir, confira também o nome
e o e-mail de autoria do Git: eles fazem parte do histórico público de commits.

## Licença

Distribuído sob a licença **GPL-3.0-only**. Consulte [LICENSE](LICENSE).
