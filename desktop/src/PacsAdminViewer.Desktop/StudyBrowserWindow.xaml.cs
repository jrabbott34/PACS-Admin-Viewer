using System.ComponentModel;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using PacsAdminViewer.Core.Archive;
using PacsAdminViewer.Core.Bridge;

namespace PacsAdminViewer.Desktop;

/// <summary>
/// Search the archive and send a study (or some of its series) to the viewer. Closing only
/// hides the window so the search is still there next time; it's really closed when the main
/// window closes or the connection changes (<see cref="CloseForGood"/>).
/// </summary>
public partial class StudyBrowserWindow : Window
{
    // Shown by the viewer while it retrieves; deliberately no patient details.
    private const string LoadLabel = "Opening study from the archive…";

    private readonly IImageArchive _archive;
    private readonly Action<LoadRequest> _open;
    private CancellationTokenSource? _searchCts;
    private CancellationTokenSource? _seriesCts;
    private bool _searchedOnce;
    private bool _opening;
    private bool _closingForGood;

    internal StudyBrowserWindow(IImageArchive archive, Action<LoadRequest> open)
    {
        InitializeComponent();
        _archive = archive;
        _open = open;
        Activated += async (_, _) =>
        {
            if (_searchedOnce) return;
            _searchedOnce = true;
            NameBox.Focus();
            await SearchAsync();
        };
    }

    internal void CloseForGood()
    {
        _closingForGood = true;
        _searchCts?.Cancel();
        _seriesCts?.Cancel();
        Close();
    }

    protected override void OnClosing(CancelEventArgs e)
    {
        if (!_closingForGood)
        {
            e.Cancel = true;
            Hide();
        }
        base.OnClosing(e);
    }

    // ---- search ----

    private async void Search_Click(object sender, RoutedEventArgs e) => await SearchAsync();

    private async void Clear_Click(object sender, RoutedEventArgs e)
    {
        NameBox.Clear();
        IdBox.Clear();
        AccessionBox.Clear();
        FromPicker.SelectedDate = null;
        ToPicker.SelectedDate = null;
        await SearchAsync();
    }

    private async Task SearchAsync()
    {
        _searchCts?.Cancel();
        var cts = _searchCts = new CancellationTokenSource();
        var query = new StudyQuery
        {
            PatientName = NameBox.Text,
            PatientId = IdBox.Text,
            AccessionNumber = AccessionBox.Text,
            DateFrom = FromPicker.SelectedDate is { } from ? DateOnly.FromDateTime(from) : null,
            DateTo = ToPicker.SelectedDate is { } to ? DateOnly.FromDateTime(to) : null,
        };
        if (query.DateFrom > query.DateTo)
        {
            SetStatus("The start date is after the end date.", error: true);
            return;
        }

        SetStatus("Searching…");
        SearchButton.IsEnabled = false;
        try
        {
            var result = await _archive.FindStudiesAsync(query, cts.Token);
            if (cts.IsCancellationRequested) return;
            StudiesGrid.ItemsSource = result.Studies;
            SeriesGrid.ItemsSource = null;
            var n = result.Studies.Count;
            SetStatus(n == 0 ? "No studies match."
                : result.Truncated ? $"Showing the first {n} studies. Narrow the search to see the rest."
                : $"{n} stud{(n == 1 ? "y" : "ies")}.");
            if (n > 0) StudiesGrid.SelectedIndex = 0;
        }
        catch (OperationCanceledException)
        {
        }
        catch (ArchiveException ex)
        {
            if (!cts.IsCancellationRequested) SetStatus(ex.Message, error: true);
        }
        finally
        {
            if (cts == _searchCts) SearchButton.IsEnabled = true;
        }
    }

    private async void Studies_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        _seriesCts?.Cancel();
        SeriesGrid.ItemsSource = null;
        UpdateButtons();
        if (StudiesGrid.SelectedItem is not StudySummary study) return;

        var cts = _seriesCts = new CancellationTokenSource();
        try
        {
            var series = await _archive.GetSeriesAsync(study.Id, cts.Token);
            if (!cts.IsCancellationRequested) SeriesGrid.ItemsSource = series;
        }
        catch (OperationCanceledException)
        {
        }
        catch (ArchiveException ex)
        {
            if (!cts.IsCancellationRequested) SetStatus(ex.Message, error: true);
        }
        UpdateButtons();
    }

    private void Series_SelectionChanged(object sender, SelectionChangedEventArgs e) => UpdateButtons();

    private void UpdateButtons()
    {
        OpenStudyButton.IsEnabled = !_opening && StudiesGrid.SelectedItem is StudySummary;
        OpenSeriesButton.IsEnabled = !_opening && SeriesGrid.SelectedItems.Count > 0;
    }

    // ---- open in the viewer ----

    private async void OpenStudy_Click(object sender, RoutedEventArgs e) => await OpenStudyAsync();

    private async void OpenSeries_Click(object sender, RoutedEventArgs e) => await OpenSeriesAsync();

    private async void Studies_DoubleClick(object sender, MouseButtonEventArgs e)
    {
        if (IsRow(StudiesGrid, e)) await OpenStudyAsync();
    }

    private async void Series_DoubleClick(object sender, MouseButtonEventArgs e)
    {
        if (IsRow(SeriesGrid, e)) await OpenSeriesAsync();
    }

    // Enter on a row opens it (the grid would otherwise just move to the next row).
    private async void Studies_KeyDown(object sender, KeyEventArgs e)
    {
        if (e.Key != Key.Enter) return;
        e.Handled = true;
        await OpenStudyAsync();
    }

    private async void Series_KeyDown(object sender, KeyEventArgs e)
    {
        if (e.Key != Key.Enter) return;
        e.Handled = true;
        await OpenSeriesAsync();
    }

    /// <summary>Double-clicks on headers, scrollbars and empty space don't open anything.</summary>
    private static bool IsRow(DataGrid grid, MouseButtonEventArgs e) =>
        e.OriginalSource is DependencyObject source && ItemsControl.ContainerFromElement(grid, source) is DataGridRow;

    private Task OpenStudyAsync() =>
        StudiesGrid.SelectedItem is StudySummary study
            ? OpenAsync(ct => LoadRequests.ForStudyAsync(_archive, study.Id, LoadLabel, ct))
            : Task.CompletedTask;

    private Task OpenSeriesAsync()
    {
        var ids = SeriesGrid.SelectedItems.OfType<SeriesSummary>().Select(s => s.Id).ToList();
        return ids.Count > 0 ? OpenAsync(ct => LoadRequests.ForSeriesAsync(_archive, ids, LoadLabel, ct)) : Task.CompletedTask;
    }

    private async Task OpenAsync(Func<CancellationToken, Task<LoadRequest>> build)
    {
        if (_opening) return;
        _opening = true;
        UpdateButtons();
        SetStatus("Finding images in the archive…");
        try
        {
            var request = await build(CancellationToken.None);
            if (request.InstanceCount == 0)
            {
                SetStatus("The archive has no images for that selection.", error: true);
                return;
            }
            SetStatus($"Sent {request.InstanceCount} image{(request.InstanceCount == 1 ? "" : "s")} to the viewer.");
            _open(request);
            Hide(); // back to the viewer, like a worklist
        }
        catch (ArchiveException ex)
        {
            SetStatus(ex.Message, error: true);
        }
        finally
        {
            _opening = false;
            UpdateButtons();
        }
    }

    private void Close_Click(object sender, RoutedEventArgs e) => Hide();

    private void SetStatus(string text, bool error = false)
    {
        StatusText.Text = text;
        StatusText.Foreground = error ? Brushes.Firebrick : SystemColors.ControlTextBrush;
    }
}
